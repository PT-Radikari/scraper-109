"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveCandidateIdentity = exports.normalizePhone = exports.normalizeEmail = void 0;
const crypto_1 = __importDefault(require("crypto"));
/** Trim + lowercase; empty becomes null. */
function normalizeEmail(email) {
    const normalized = (email !== null && email !== void 0 ? email : "").trim().toLowerCase();
    return normalized === "" ? null : normalized;
}
exports.normalizeEmail = normalizeEmail;
/**
 * Canonicalizes Indonesian phone numbers so +62, 62 and leading-0 spellings of
 * the same number compare equal. Formatting characters are stripped; anything
 * too short to be a phone number becomes null.
 */
function normalizePhone(phone) {
    const digits = (phone !== null && phone !== void 0 ? phone : "").replace(/\D/g, "");
    if (digits.length < 7)
        return null;
    if (digits.startsWith("62"))
        return digits;
    if (digits.startsWith("0"))
        return `62${digits.slice(1)}`;
    return digits;
}
exports.normalizePhone = normalizePhone;
function normalizeText(value) {
    return (value !== null && value !== void 0 ? value : "").trim().toLowerCase().replace(/\s+/g, " ");
}
function sha1(value) {
    return crypto_1.default.createHash("sha1").update(value).digest("hex");
}
function fingerprintParts(input) {
    var _a, _b, _c, _d, _e;
    const name = normalizeText(input.name);
    const dob = normalizeText(input.dateOfBirth);
    if (name !== "" && dob !== "") {
        return ["name", name, "dob", dob];
    }
    const education = ((_a = input.education) !== null && _a !== void 0 ? _a : []).find((e) => normalizeText(e.institution) !== "");
    if (name !== "" && education) {
        const year = normalizeText((_b = education.period_end_year) !== null && _b !== void 0 ? _b : education.period_start_year);
        return ["name", name, "edu", normalizeText(education.institution), year];
    }
    const work = ((_c = input.workExperience) !== null && _c !== void 0 ? _c : []).find((w) => normalizeText(w.organization) !== "" || normalizeText(w.position) !== "");
    if (name !== "" && work) {
        return ["name", name, "work", normalizeText(work.organization), normalizeText(work.position)];
    }
    if (name !== "") {
        return ["name", name];
    }
    return [
        "raw",
        JSON.stringify([dob, (_d = input.education) !== null && _d !== void 0 ? _d : [], (_e = input.workExperience) !== null && _e !== void 0 ? _e : []]),
    ];
}
function resolveCandidateIdentity(input) {
    var _a, _b, _c;
    const email = normalizeEmail(input.email);
    const phone = normalizePhone(input.phone);
    const nativeId = ((_a = input.portalCandidateId) !== null && _a !== void 0 ? _a : "").trim();
    if (nativeId !== "") {
        return { portalCandidateId: nativeId, email, phone, source: "portal", lowConfidence: false };
    }
    const urlProfile = ((_b = input.urlProfile) !== null && _b !== void 0 ? _b : "").trim();
    const vacancyUrl = ((_c = input.vacancyUrl) !== null && _c !== void 0 ? _c : "").trim();
    if (urlProfile !== "" && urlProfile !== vacancyUrl) {
        return { portalCandidateId: sha1(urlProfile), email, phone, source: "url_profile", lowConfidence: false };
    }
    if (email) {
        return { portalCandidateId: sha1(email), email, phone, source: "email", lowConfidence: false };
    }
    if (phone) {
        return { portalCandidateId: sha1(`phone:${phone}`), email, phone, source: "phone", lowConfidence: false };
    }
    return {
        portalCandidateId: sha1(`fp:${fingerprintParts(input).join("|")}`),
        email,
        phone,
        source: "fingerprint",
        lowConfidence: true,
    };
}
exports.resolveCandidateIdentity = resolveCandidateIdentity;
