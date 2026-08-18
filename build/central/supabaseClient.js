"use strict";
/**
 * Minimal PostgREST client for the central Supabase database.
 *
 * The repository already depends on axios, so the central writer speaks
 * PostgREST over HTTP rather than pulling in a Postgres driver. The HTTP layer
 * is injectable ({@link HttpTransport}) so tests can drive the client without a
 * live Supabase project.
 */
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SupabaseRestClient = exports.AxiosHttpTransport = void 0;
const axios_1 = __importDefault(require("axios"));
/**
 * The default axios-backed transport.
 */
class AxiosHttpTransport {
    /**
     * Issues the request through axios.
     * @param request The request to send.
     * @returns The status and parsed body.
     */
    request(request) {
        return __awaiter(this, void 0, void 0, function* () {
            const response = yield axios_1.default.request({
                method: request.method,
                url: request.url,
                headers: request.headers,
                params: request.params,
                data: request.data,
                timeout: request.timeout,
            });
            return { status: response.status, data: response.data };
        });
    }
}
exports.AxiosHttpTransport = AxiosHttpTransport;
/**
 * Thin PostgREST wrapper: upsert, select and RPC against Supabase.
 */
class SupabaseRestClient {
    /**
     * @param config Resolved central configuration.
     * @param transport HTTP layer; defaults to axios.
     */
    constructor(config, transport = new AxiosHttpTransport()) {
        this.config = config;
        this.transport = transport;
    }
    /**
     * True when the client has the credentials it needs to talk to Supabase.
     * @returns Whether central calls may be attempted.
     */
    isConfigured() {
        return Boolean(this.config.supabaseUrl) && Boolean(this.config.supabaseKey);
    }
    /**
     * Builds the headers shared by every PostgREST call.
     * @param schema Schema targeted by the call.
     * @returns The header map.
     */
    baseHeaders(schema) {
        return {
            apikey: this.config.supabaseKey,
            Authorization: `Bearer ${this.config.supabaseKey}`,
            "Content-Type": "application/json",
            "Accept-Profile": schema,
            "Content-Profile": schema,
        };
    }
    /**
     * Fails fast with a clear message when credentials are missing.
     * @throws When the client is not configured.
     */
    assertConfigured() {
        if (!this.isConfigured()) {
            throw new Error("Central Supabase is not configured: set CENTRAL_SUPABASE_URL and CENTRAL_SUPABASE_SERVICE_KEY");
        }
    }
    /**
     * Upserts rows into a central table.
     * @param table Table name inside the target schema.
     * @param rows Rows to write; an empty array is a no-op.
     * @param options Conflict target and response preferences.
     * @returns The written rows when representation was requested.
     */
    upsert(table, rows, options) {
        return __awaiter(this, void 0, void 0, function* () {
            this.assertConfigured();
            if (rows.length === 0)
                return [];
            const schema = options.schema || this.config.scraperSchema;
            const prefer = ["resolution=merge-duplicates"];
            prefer.push(options.returnRepresentation === false ? "return=minimal" : "return=representation");
            if (options.mergeMissing !== false)
                prefer.push("missing=default");
            const response = yield this.transport.request({
                method: "POST",
                url: `${this.config.supabaseUrl}/rest/v1/${table}`,
                headers: Object.assign(Object.assign({}, this.baseHeaders(schema)), { Prefer: prefer.join(",") }),
                params: { on_conflict: options.onConflict },
                data: rows,
                timeout: this.config.requestTimeoutMs,
            });
            return Array.isArray(response.data) ? response.data : [];
        });
    }
    /**
     * Runs a PostgREST select.
     * @param table Table name inside the target schema.
     * @param params PostgREST query parameters, e.g. `{ select: "*", email: "eq.a@b.c" }`.
     * @param schema Schema override; defaults to the scraper schema.
     * @returns The matching rows.
     */
    select(table, params, schema) {
        return __awaiter(this, void 0, void 0, function* () {
            this.assertConfigured();
            const response = yield this.transport.request({
                method: "GET",
                url: `${this.config.supabaseUrl}/rest/v1/${table}`,
                headers: this.baseHeaders(schema || this.config.scraperSchema),
                params,
                timeout: this.config.requestTimeoutMs,
            });
            return Array.isArray(response.data) ? response.data : [];
        });
    }
    /**
     * Calls a Postgres function through PostgREST.
     * @param fn Function name.
     * @param args Named function arguments.
     * @param schema Schema override; defaults to the scraper schema.
     * @returns Whatever the function returned.
     */
    rpc(fn, args, schema) {
        return __awaiter(this, void 0, void 0, function* () {
            this.assertConfigured();
            const response = yield this.transport.request({
                method: "POST",
                url: `${this.config.supabaseUrl}/rest/v1/rpc/${fn}`,
                headers: this.baseHeaders(schema || this.config.scraperSchema),
                data: args,
                timeout: this.config.requestTimeoutMs,
            });
            return response.data;
        });
    }
}
exports.SupabaseRestClient = SupabaseRestClient;
