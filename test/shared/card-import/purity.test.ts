import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Модуль работает и в браузере: разрешены только zod, свои файлы и чистые функции src/domain.
const dir = join(import.meta.dirname, "../../../src/shared/card-import");
const allowed = [/^zod$/, /^\.\/[\w-]+\.js$/, /^\.\.\/\.\.\/domain\/(normalize|word-key)\.js$/];

describe("card-import без Node API, DOM и серверных зависимостей", () => {
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".ts"))) {
    it(file, () => {
      const source = readFileSync(join(dir, file), "utf8");
      const imports = [...source.matchAll(/(?:from|import)\s+["']([^"']+)["']/g)].map((m) => m[1]!);
      for (const specifier of imports) expect(allowed.some((re) => re.test(specifier)), specifier).toBe(true);
      expect(source).not.toMatch(/\b(process|Buffer|require|window|document|globalThis)\b/);
    });
  }
  it("src/domain/normalize.ts и word-key.ts тоже чистые", () => {
    for (const file of ["normalize.ts", "word-key.ts"]) {
      const source = readFileSync(join(dir, "../../domain", file), "utf8");
      const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]!);
      expect(imports.every((s) => s.startsWith("./")), file).toBe(true);
      expect(source).not.toMatch(/\b(process|Buffer|require|window|document)\b/);
    }
  });
});
