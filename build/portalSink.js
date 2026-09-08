"use strict";
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
exports.sendApplicantToSink = void 0;
const crypto_1 = __importDefault(require("crypto"));
const supabaseSink_1 = require("./supabaseSink");
const candidateIdentity_1 = require("./candidateIdentity");
function uploadOptionalArtifact(sink, portal, kind, localPath, bytes) {
    return __awaiter(this, void 0, void 0, function* () {
        if (localPath) {
            return sink.uploadArtifact(portal, kind, localPath);
        }
        if (bytes) {
            return sink.uploadArtifactBytes(portal, kind, bytes.bytes, bytes.extension);
        }
        return null;
    });
}
/**
 * Writes one applicant straight into the scoring Supabase, mirroring
 * Glints.sendToSink step for step. Idempotent across re-scrapes: vacancies and
 * candidates are write-once (refresh touches last_seen_at only, statuses are
 * never reset) and the application link ignores duplicates.
 *
 * Errors are sanitized (no PII, no keys) before they are logged and rethrown,
 * so a failing cycle surfaces one loud, safe line per applicant.
 *
 * @returns the scrape.* row ids of the upserted vacancy and candidate.
 */
function sendApplicantToSink(sink, a) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q;
        const vacancyId = ((_a = a.vacancy_id) !== null && _a !== void 0 ? _a : "").trim() !== ""
            ? a.vacancy_id.trim()
            : crypto_1.default.createHash("sha1").update(`${a.portal}${a.applied_for}`).digest("hex");
        const identity = (0, candidateIdentity_1.resolveCandidateIdentity)({
            portalCandidateId: a.portal_candidate_id,
            urlProfile: a.url_profile,
            vacancyUrl: a.vacancy_url,
            email: a.email,
            phone: a.phone,
            name: a.name,
            dateOfBirth: a.date_of_birth,
            education: a.education,
            workExperience: a.work_experience,
        });
        try {
            const appliedDate = a.applied_date && a.applied_date !== "0" ? a.applied_date : null;
            const cvKey = yield uploadOptionalArtifact(sink, a.portal, "cv", a.cv_path, a.cv_bytes);
            const photoKey = yield uploadOptionalArtifact(sink, a.portal, "photo", a.photo_path, a.photo_bytes);
            const vacancyRowId = yield sink.upsertVacancy({
                portal: a.portal,
                portal_vacancy_id: vacancyId,
                title: a.applied_for,
                link: (_c = (_b = a.vacancy_link) !== null && _b !== void 0 ? _b : a.vacancy_url) !== null && _c !== void 0 ? _c : null,
                status: "new",
                raw: Object.assign({ type: "applicant" }, ((_d = a.vacancy_raw) !== null && _d !== void 0 ? _d : {})),
            });
            const candidateRowId = yield sink.upsertCandidate({
                portal: a.portal,
                portal_candidate_id: identity.portalCandidateId,
                email: identity.email,
                phone: identity.phone,
                name: (_e = a.name) !== null && _e !== void 0 ? _e : null,
                cv_object_key: cvKey,
                photo_object_key: photoKey,
                data: Object.assign(Object.assign({}, ((_f = a.raw) !== null && _f !== void 0 ? _f : {})), { portal: a.portal, applied_for: a.applied_for, applied_date: appliedDate, url_profile: (_g = a.url_profile) !== null && _g !== void 0 ? _g : null, name: (_h = a.name) !== null && _h !== void 0 ? _h : null, email: identity.email, date_of_birth: (_j = a.date_of_birth) !== null && _j !== void 0 ? _j : null, location: (_k = a.location) !== null && _k !== void 0 ? _k : null, contact: { type: "phone", contact_number: (_m = (_l = identity.phone) !== null && _l !== void 0 ? _l : a.phone) !== null && _m !== void 0 ? _m : "" }, work_experience: (_o = a.work_experience) !== null && _o !== void 0 ? _o : [], education: (_p = a.education) !== null && _p !== void 0 ? _p : [], skill: (_q = a.skill) !== null && _q !== void 0 ? _q : [], identity: {
                        source: identity.source,
                        low_confidence: identity.lowConfidence,
                        email: identity.email,
                        phone: identity.phone,
                    } }),
            });
            yield sink.linkApplication(vacancyRowId, candidateRowId, {
                applied_for: a.applied_for,
                applied_date: appliedDate,
            });
            console.info("Success writing applicant to Supabase sink", {
                portal: a.portal,
                candidate_id: identity.portalCandidateId,
                identity_source: identity.source,
            });
            return { vacancyRowId, candidateRowId };
        }
        catch (error) {
            const sinkError = (0, supabaseSink_1.sanitizeSinkError)(error, "sendToSink");
            sinkError.portal = a.portal;
            sinkError.vacancyId = vacancyId;
            sinkError.candidateId = identity.portalCandidateId;
            console.error("Error writing to Supabase sink", {
                portal: a.portal,
                vacancy_id: vacancyId,
                candidate_id: identity.portalCandidateId,
                identity_source: identity.source,
                status: sinkError.status,
                error: sinkError.message,
            });
            throw sinkError;
        }
    });
}
exports.sendApplicantToSink = sendApplicantToSink;
