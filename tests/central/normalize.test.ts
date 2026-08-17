import {
  applicationNaturalKey,
  candidateNaturalKey,
  jobVacancyNaturalKey,
  normalizeEmail,
  normalizeIdentity,
  normalizeName,
  normalizeNik,
  normalizePhone,
} from "../../src/central/normalize";

describe("central/normalize", () => {
  describe("normalizeEmail", () => {
    it("trims and lower-cases", () => {
      expect(normalizeEmail("  John.Doe@Example.COM ")).toBe("john.doe@example.com");
    });

    it("rejects values that are not addresses", () => {
      expect(normalizeEmail("not-an-email")).toBeNull();
      expect(normalizeEmail("")).toBeNull();
      expect(normalizeEmail(null)).toBeNull();
    });
  });

  describe("normalizePhone", () => {
    it("collapses the Indonesian spellings onto one number", () => {
      expect(normalizePhone("0812-3456-7890")).toBe("6281234567890");
      expect(normalizePhone("+62 812 3456 7890")).toBe("6281234567890");
      expect(normalizePhone("6281234567890")).toBe("6281234567890");
    });

    it("rejects numbers too short to identify anybody", () => {
      expect(normalizePhone("12345")).toBeNull();
      expect(normalizePhone("-")).toBeNull();
      expect(normalizePhone(undefined)).toBeNull();
    });
  });

  describe("normalizeName", () => {
    it("collapses whitespace and lower-cases", () => {
      expect(normalizeName("  John   Doe ")).toBe("john doe");
      expect(normalizeName("   ")).toBeNull();
    });
  });

  describe("normalizeNik", () => {
    it("keeps 16 digit numbers only", () => {
      expect(normalizeNik("3201-0101-9001-0001")).toBe("3201010190010001");
      expect(normalizeNik("320101019001")).toBeNull();
    });
  });

  describe("normalizeIdentity", () => {
    it("normalises every identity field at once", () => {
      expect(
        normalizeIdentity({
          email: "A@B.CO",
          phone: "0812 3456 7890",
          full_name: " Jane  Doe ",
          nik: "3201010190010001",
        })
      ).toEqual({
        email: "a@b.co",
        phone: "6281234567890",
        full_name: "jane doe",
        nik: "3201010190010001",
      });
    });
  });

  describe("candidateNaturalKey", () => {
    it("prefers the NIK, then the email, then the phone", () => {
      expect(
        candidateNaturalKey({
          source_portal: "Glints",
          nik: "3201010190010001",
          email: "a@b.co",
          phone: "0812 3456 7890",
        })
      ).toBe("glints:nik:3201010190010001");

      expect(candidateNaturalKey({ source_portal: "glints", email: "a@b.co", phone: "081234567890" })).toBe(
        "glints:email:a@b.co"
      );

      expect(candidateNaturalKey({ source_portal: "glints", phone: "081234567890" })).toBe(
        "glints:phone:6281234567890"
      );
    });

    it("gives the same key for the same person spelled differently", () => {
      const a = candidateNaturalKey({ source_portal: "jooble", email: " John@Example.com " });
      const b = candidateNaturalKey({ source_portal: "Jooble", email: "john@example.com" });
      expect(a).toBe(b);
    });

    it("falls back to the portal id and then the name", () => {
      expect(candidateNaturalKey({ source_portal: "seek", source_candidate_id: "42" })).toBe(
        "seek:portal_id:42"
      );
      expect(candidateNaturalKey({ source_portal: "seek", full_name: "Jane Doe" })).toBe(
        "seek:name:jane doe"
      );
    });

    it("throws when there is no identity at all", () => {
      expect(() => candidateNaturalKey({ source_portal: "seek" })).toThrow(
        /Cannot build a candidate natural key/
      );
    });
  });

  describe("jobVacancyNaturalKey", () => {
    it("keys on the portal vacancy id", () => {
      expect(
        jobVacancyNaturalKey({ source_portal: "Pintarnya", source_vacancy_id: "283020" })
      ).toBe("pintarnya:vacancy:283020");
    });

    it("throws without a vacancy id", () => {
      expect(() => jobVacancyNaturalKey({ source_portal: "pintarnya", source_vacancy_id: "" })).toThrow(
        /source_vacancy_id/
      );
    });
  });

  describe("applicationNaturalKey", () => {
    it("uses the portal application id when present", () => {
      expect(
        applicationNaturalKey({
          source_portal: "glints",
          source_application_id: "app-1",
          candidate: { email: "a@b.co" },
        })
      ).toBe("glints:application:app-1");
    });

    it("falls back to the candidate and vacancy pair", () => {
      expect(
        applicationNaturalKey({
          source_portal: "glints",
          source_vacancy_id: "v-9",
          candidate: { email: "A@B.co" },
        })
      ).toBe("glints:application:glints:email:a@b.co|v-9");
    });
  });
});
