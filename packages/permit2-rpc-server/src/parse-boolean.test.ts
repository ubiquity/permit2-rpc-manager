import { parseBoolean } from "./parse-boolean.ts";

for (
  const [expected, aliases] of [
    [true, ["1", "true", "yes", "y", "on"]],
    [false, ["0", "false", "no", "n", "off"]],
  ] as const
) {
  for (const alias of aliases) {
    const mixedCase = [...alias].map((letter, index) => index % 2 ? letter.toUpperCase() : letter).join("");
    for (const variant of new Set([alias, alias.toUpperCase(), mixedCase])) {
      for (const raw of [variant, ` \t${variant}\r\n`]) {
        Deno.test(`parseBoolean(${JSON.stringify(raw)}) is ${expected}`, () => {
          if (parseBoolean(raw) !== expected) throw new Error(`Expected ${expected} for ${JSON.stringify(raw)}`);
        });
      }
    }
  }
}

for (const raw of [undefined, "", " \t\n", "unknown", "2"]) {
  Deno.test(`parseBoolean(${JSON.stringify(raw)}) preserves the default`, () => {
    if (parseBoolean(raw) !== undefined) throw new Error("Expected an unset Boolean value");
    if ((parseBoolean(raw) ?? true) !== true) throw new Error("Chain validation must default to true");
  });
}
