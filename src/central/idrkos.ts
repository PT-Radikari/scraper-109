/**
 * IDRKOS cross-checking.
 *
 * Every scraped candidate is checked against the IDRKOS candidate pool before
 * it lands in the central talent listing:
 *
 * - already in IDRKOS -> link `idrkos_staf_id`, status `idrkos_verified`
 * - not in IDRKOS (scraped or QR onboarded) -> status `scraped_new`, and the
 *   candidate is prioritised at the top of the talent listings
 *
 * The lookup runs against the `cross_check_idrkos_candidate` Postgres function
 * when Supabase is reachable, and falls back to the IDRKOS `/talents` HTTP API
 * otherwise. When neither backend is reachable the candidate is treated as new
 * and re-checked on the next sync pass.
 */

import { CentralConfig } from "./config";
import { normalizeIdentity } from "./normalize";
import { HttpTransport, AxiosHttpTransport, SupabaseRestClient } from "./supabaseClient";
import {
  CandidateCrossCheckResult,
  LISTING_PRIORITY,
  ScrapedCandidate,
} from "./types";

/**
 * Row shape returned by the `cross_check_idrkos_candidate` Postgres function.
 */
type CrossCheckRpcRow = {
  matched: boolean;
  idrkos_staf_id: string | null;
  status: string;
  match_field: string | null;
  listing_priority: number | null;
};

/**
 * Talent record as returned by the IDRKOS `/talents` API.
 */
type IdrkosTalent = {
  id?: string | number;
  staf_id?: string | number;
  email?: string | null;
  phone?: string | null;
  nik?: string | null;
  name?: string | null;
  fullname?: string | null;
};

/**
 * The verdict used when nothing matched.
 * @param source Which backend produced the verdict.
 * @returns A `scraped_new` cross-check result.
 */
function newCandidateResult(source: CandidateCrossCheckResult["source"]): CandidateCrossCheckResult {
  return {
    matched: false,
    idrkos_staf_id: null,
    status: "scraped_new",
    match_field: null,
    listing_priority: LISTING_PRIORITY.scraped_new,
    source,
  };
}

/**
 * Cross-checks scraped candidates against the IDRKOS candidate pool.
 */
export class IdrkosService {
  private readonly config: CentralConfig;
  private readonly supabase: SupabaseRestClient;
  private readonly transport: HttpTransport;

  /**
   * @param config Resolved central configuration.
   * @param supabase Client used for the RPC path.
   * @param transport HTTP layer used for the `/talents` API path.
   */
  constructor(
    config: CentralConfig,
    supabase: SupabaseRestClient = new SupabaseRestClient(config),
    transport: HttpTransport = new AxiosHttpTransport()
  ) {
    this.config = config;
    this.supabase = supabase;
    this.transport = transport;
  }

  /**
   * Cross-checks one candidate against IDRKOS.
   *
   * @param candidate The scraped candidate identity.
   * @returns The verdict: linked and verified, or new and prioritised.
   */
  async crossCheckCandidate(
    candidate: Pick<ScrapedCandidate, "email" | "phone" | "full_name" | "nik">
  ): Promise<CandidateCrossCheckResult> {
    const identity = normalizeIdentity(candidate);

    // Nothing to match on: the candidate can only be new.
    if (!identity.email && !identity.phone && !identity.nik && !identity.full_name) {
      return newCandidateResult("none");
    }

    const mode = this.config.idrkosMode;

    if (mode === "rpc" || mode === "auto") {
      const viaRpc = await this.crossCheckViaRpc(identity);
      if (viaRpc) return viaRpc;
      if (mode === "rpc") return newCandidateResult("none");
    }

    const viaApi = await this.crossCheckViaApi(identity);
    if (viaApi) return viaApi;

    return newCandidateResult("none");
  }

  /**
   * Calls the `cross_check_idrkos_candidate` Postgres function.
   * @param identity Normalised candidate identity.
   * @returns The verdict, or `null` when the RPC is unavailable or errored.
   */
  private async crossCheckViaRpc(
    identity: ReturnType<typeof normalizeIdentity>
  ): Promise<CandidateCrossCheckResult | null> {
    if (!this.supabase.isConfigured()) return null;

    try {
      const payload = await this.supabase.rpc<CrossCheckRpcRow | CrossCheckRpcRow[]>(
        "cross_check_idrkos_candidate",
        {
          p_email: identity.email,
          p_phone: identity.phone,
          p_nik: identity.nik,
          p_full_name: identity.full_name,
        }
      );

      const row = Array.isArray(payload) ? payload[0] : payload;
      if (!row) return newCandidateResult("rpc");

      // A deployed database may still run an older function version whose
      // final fallback links on name alone; that link is untrustworthy, so
      // it is rejected here just like the local re-verification on the API
      // path in pickTalent.
      if (row.match_field === "name") return newCandidateResult("rpc");

      return this.toResult(
        Boolean(row.matched && row.idrkos_staf_id),
        row.idrkos_staf_id ? String(row.idrkos_staf_id) : null,
        (row.match_field as CandidateCrossCheckResult["match_field"]) || null,
        "rpc"
      );
    } catch (error) {
      console.warn(
        "IDRKOS cross-check via RPC failed, falling back:",
        (error as Error).message
      );
      return null;
    }
  }

  /**
   * Queries the IDRKOS `/talents` API, one identity field at a time.
   * @param identity Normalised candidate identity.
   * @returns The verdict, or `null` when the API is unavailable or errored.
   */
  private async crossCheckViaApi(
    identity: ReturnType<typeof normalizeIdentity>
  ): Promise<CandidateCrossCheckResult | null> {
    if (!this.config.idrkosBaseUrl) return null;

    const lookups: { field: CandidateCrossCheckResult["match_field"]; value: string }[] = [];
    if (identity.nik) lookups.push({ field: "nik", value: identity.nik });
    if (identity.email) lookups.push({ field: "email", value: identity.email });
    if (identity.phone) lookups.push({ field: "phone", value: identity.phone });

    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.config.idrkosApiKey) {
      headers.Authorization = `Bearer ${this.config.idrkosApiKey}`;
    }

    try {
      for (const lookup of lookups) {
        const response = await this.transport.request<unknown>({
          method: "GET",
          url: `${this.config.idrkosBaseUrl}${this.config.idrkosTalentsPath}`,
          headers,
          params: { [lookup.field as string]: lookup.value },
          timeout: this.config.requestTimeoutMs,
        });

        const talent = this.pickTalent(response.data, identity, lookup.field);
        if (talent) {
          const stafId = talent.staf_id ?? talent.id;
          return this.toResult(
            stafId !== undefined && stafId !== null,
            stafId !== undefined && stafId !== null ? String(stafId) : null,
            lookup.field,
            "api"
          );
        }
      }

      return newCandidateResult("api");
    } catch (error) {
      console.warn(
        "IDRKOS cross-check via /talents API failed:",
        (error as Error).message
      );
      return null;
    }
  }

  /**
   * Extracts a matching talent from an API response.
   *
   * The endpoint may answer with a bare array, a `{ data: [...] }` envelope or
   * a single object; all three are accepted. The candidate identity is
   * re-verified locally so a fuzzy server-side search cannot produce a false
   * link.
   * @param body Raw response body.
   * @param identity Normalised candidate identity.
   * @param field Field the lookup was keyed on.
   * @returns The matching talent, or `undefined`.
   */
  private pickTalent(
    body: unknown,
    identity: ReturnType<typeof normalizeIdentity>,
    field: CandidateCrossCheckResult["match_field"]
  ): IdrkosTalent | undefined {
    const envelope = body as { data?: unknown; talents?: unknown } | null;
    const raw =
      Array.isArray(body) ? body
      : Array.isArray(envelope?.data) ? envelope!.data
      : Array.isArray(envelope?.talents) ? envelope!.talents
      : body && typeof body === "object" ? [body]
      : [];

    const talents = raw as IdrkosTalent[];

    return talents.find((talent) => {
      const talentIdentity = normalizeIdentity({
        email: talent.email,
        phone: talent.phone,
        nik: talent.nik,
        full_name: talent.name || talent.fullname,
      });

      if (field === "nik") return Boolean(identity.nik) && talentIdentity.nik === identity.nik;
      if (field === "email") return Boolean(identity.email) && talentIdentity.email === identity.email;
      if (field === "phone") return Boolean(identity.phone) && talentIdentity.phone === identity.phone;
      return false;
    });
  }

  /**
   * Assembles a cross-check result and its listing priority.
   * @param matched Whether IDRKOS knows this candidate.
   * @param stafId The linked IDRKOS staf id when matched.
   * @param matchField Field that produced the match.
   * @param source Backend that produced the verdict.
   * @returns The cross-check result.
   */
  private toResult(
    matched: boolean,
    stafId: string | null,
    matchField: CandidateCrossCheckResult["match_field"],
    source: CandidateCrossCheckResult["source"]
  ): CandidateCrossCheckResult {
    if (!matched) return newCandidateResult(source);

    return {
      matched: true,
      idrkos_staf_id: stafId,
      status: "idrkos_verified",
      match_field: matchField,
      listing_priority: LISTING_PRIORITY.idrkos_verified,
      source,
    };
  }
}
