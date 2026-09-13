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
exports.saveHidden = exports.loadHidden = exports.updateHidden = exports.normalizeHidden = exports.HIDDEN_ROWS_KEY = void 0;
const axios_1 = __importDefault(require("axios"));
const dashboardData_1 = require("./dashboardData");
exports.HIDDEN_ROWS_KEY = "scrapview/hidden.json";
const EMPTY = { candidates: [], vacancies: [] };
/** Positive integer ids only, de-duplicated and sorted; anything else is dropped. */
function normalizeHidden(value) {
    const ids = (list) => Array.from(new Set((Array.isArray(list) ? list : []).filter((id) => Number.isInteger(id) && id > 0))).sort((a, b) => a - b);
    const source = (value !== null && typeof value === "object" ? value : {});
    return { candidates: ids(source.candidates), vacancies: ids(source.vacancies) };
}
exports.normalizeHidden = normalizeHidden;
/** Returns a new list with `ids` hidden or restored for one kind of row. */
function updateHidden(hidden, kind, ids, action) {
    const current = new Set(normalizeHidden(hidden)[kind]);
    for (const id of ids) {
        if (!Number.isInteger(id) || id <= 0)
            continue;
        if (action === "hide")
            current.add(id);
        else
            current.delete(id);
    }
    return normalizeHidden(Object.assign(Object.assign({}, normalizeHidden(hidden)), { [kind]: Array.from(current) }));
}
exports.updateHidden = updateHidden;
function objectUrl(config) {
    return `${config.url}/storage/v1/object/${config.bucket}/${exports.HIDDEN_ROWS_KEY}`;
}
function statusOf(error) {
    var _a;
    return (_a = error === null || error === void 0 ? void 0 : error.response) === null || _a === void 0 ? void 0 : _a.status;
}
/**
 * The current hidden list. Without a service key nothing can ever have been
 * hidden, so that reads as an empty list rather than an error; a missing
 * object (never saved yet) or an unreadable one does too.
 */
function loadHidden(config) {
    return __awaiter(this, void 0, void 0, function* () {
        if (!config.serviceKey)
            return Object.assign({}, EMPTY);
        try {
            const response = yield axios_1.default.get(objectUrl(config), {
                headers: { apikey: config.serviceKey, Authorization: `Bearer ${config.serviceKey}` },
                responseType: "arraybuffer",
            });
            return normalizeHidden(JSON.parse(Buffer.from(response.data).toString("utf8")));
        }
        catch (error) {
            if (error instanceof SyntaxError)
                return Object.assign({}, EMPTY);
            const status = statusOf(error);
            if (status === 400 || status === 404)
                return Object.assign({}, EMPTY);
            throw new dashboardData_1.DashboardDataError(`dashboard: load hidden rows failed${status ? ` (${status})` : ""}`, status);
        }
    });
}
exports.loadHidden = loadHidden;
/** Persists the hidden list (overwriting the previous one). */
function saveHidden(config, hidden) {
    return __awaiter(this, void 0, void 0, function* () {
        if (!config.serviceKey) {
            throw new dashboardData_1.DashboardDataError("hiding rows needs SCORING_SUPABASE_SERVICE_KEY on the viewer", 501);
        }
        try {
            yield axios_1.default.post(objectUrl(config), Buffer.from(JSON.stringify(normalizeHidden(hidden))), {
                headers: {
                    apikey: config.serviceKey,
                    Authorization: `Bearer ${config.serviceKey}`,
                    "Content-Type": "application/json",
                    "x-upsert": "true",
                },
            });
        }
        catch (error) {
            const status = statusOf(error);
            throw new dashboardData_1.DashboardDataError(`dashboard: save hidden rows failed${status ? ` (${status})` : ""}`, status);
        }
    });
}
exports.saveHidden = saveHidden;
