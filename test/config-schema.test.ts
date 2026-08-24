import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { KNOWN_FIELDS, readConfigFile } from "../src/config-file.ts";
import { EFFORT_LEVELS } from "../src/directive.ts";
import { APPROVAL_MODES, LEVELS, PERMISSION_MODES, PROGRESS_MODES } from "../src/options.ts";

const schemaPath = fileURLToPath(new URL("../mention-forwarder-claude-code.config.schema.json", import.meta.url));
const examplePath = fileURLToPath(new URL("../mention-forwarder-claude-code.config.example.json", import.meta.url));
const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
const properties: Record<string, any> = schema.properties;

describe("the settings schema", () => {
  it("describes every setting, and nothing that is not one", () => {
    const described = Object.keys(properties).filter((key) => key !== "$schema");
    deepStrictEqual(described.sort(), [...KNOWN_FIELDS].sort());
  });

  it("gives every setting a description to hover", () => {
    for (const [key, property] of Object.entries(properties)) {
      ok(typeof property.description === "string" && property.description.length > 0, `"${key}" has no description`);
    }
  });

  it("offers the same values the program accepts", () => {
    deepStrictEqual(properties["effort"].enum, [...EFFORT_LEVELS]);
    deepStrictEqual(properties["permissionMode"].enum, [...PERMISSION_MODES]);
    deepStrictEqual(properties["approval"].enum, [...APPROVAL_MODES]);
    deepStrictEqual(properties["progress"].enum, [...PROGRESS_MODES]);
    deepStrictEqual(properties["logLevel"].enum, [...LEVELS]);
  });

  it("describes each of those values, since that is what a completion list shows", () => {
    for (const [key, property] of Object.entries(properties)) {
      if (property.enum === undefined) continue;
      deepStrictEqual(property.enumDescriptions?.length, property.enum.length, `"${key}" describes the wrong number of values`);
    }
  });

  it("lists every value in the description itself, since a hover only shows the one under the cursor", () => {
    for (const [key, property] of Object.entries(properties)) {
      if (property.enum === undefined) continue;
      for (const value of property.enum) {
        ok(property.description.includes(value), `"${key}" does not name "${value}" in its description`);
        ok(property.markdownDescription.includes(value), `"${key}" does not name "${value}" in its markdownDescription`);
      }
    }
  });

  it("marks anything else as a mistake, the way the program does", () => {
    strictEqual(schema.additionalProperties, false);
  });

  it("covers the example file, which the program reads despite its $schema line", () => {
    const example = JSON.parse(readFileSync(examplePath, "utf8"));
    for (const key of Object.keys(example)) ok(key in properties, `the example file's "${key}" is not in the schema`);
    strictEqual(readConfigFile(examplePath).model, "opus");
  });

  it("is spelled out in full by the example file, so every setting is visible there", () => {
    const example = JSON.parse(readFileSync(examplePath, "utf8"));
    const missing = KNOWN_FIELDS.filter((key) => !(key in example));
    deepStrictEqual(missing, [], `the example file is missing ${missing.join(", ")}`);
  });
});
