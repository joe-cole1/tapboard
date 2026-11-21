import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_XML_DEPTH,
  MAX_XML_ELEMENTS,
  parseXml,
  XmlSyntaxError,
} from "../src/features/beverages/recipe-files/xml.ts";

void test("XML reader keeps element text with entities, character references, CDATA and comments", () => {
  const root = parseXml(
    '﻿<?xml version="1.0"?>\n<!-- lead -->\n<RECIPES a="1 > 0"><RECIPE><NAME>A &amp; B &lt;&#65;&#x42;&gt; &quot;&apos;&#00000000000067;&#x0000000044;</NAME>' +
      "<NOTES><![CDATA[<raw> & text]]></NOTES><!-- skipped --><EMPTY/><?pi data?></RECIPE></RECIPES>\n<!-- tail -->",
  );
  assert.equal(root.name, "RECIPES");
  const recipe = root.children[0]!;
  assert.deepEqual(
    recipe.children.map((child) => [child.name, child.text]),
    [
      ["NAME", "A & B <AB> \"'CD"],
      ["NOTES", "<raw> & text"],
      ["EMPTY", ""],
    ],
  );
});

void test("XML reader rejects DTDs, entity declarations and unknown or malformed entities", () => {
  for (const bad of [
    '<!DOCTYPE r [<!ENTITY x "y">]><r>&x;</r>',
    '<!DOCTYPE r SYSTEM "file:///etc/passwd"><r/>',
    "<r><!ENTITY x 'y'></r>",
    "<r>&nbsp;</r>",
    "<r>&amp</r>",
    "<r>a & b</r>",
    "<r>&#0;</r>",
    "<r>&#xD800;</r>",
    "<r>&#x110000;</r>",
    "<r>&#1;</r>",
  ])
    assert.throws(() => parseXml(bad), XmlSyntaxError, bad);
});

void test("XML reader rejects broken structure", () => {
  for (const bad of [
    "",
    "   ",
    "text",
    "<r>",
    "<r></s>",
    "<r><a></r></a>",
    "<r/><s/>",
    "<r/>trailing",
    "<r><!-- open</r>",
    "<r><![CDATA[open</r>",
    "<r a=1/>",
    "<r a='1/>",
    "<1r/>",
    "<r></r ",
  ])
    assert.throws(() => parseXml(bad), XmlSyntaxError, JSON.stringify(bad));
});

void test("XML reader bounds depth and element count", () => {
  const nested = (depth: number) => "<a>".repeat(depth) + "</a>".repeat(depth);
  assert.equal(parseXml(nested(MAX_XML_DEPTH)).name, "a");
  assert.throws(() => parseXml(nested(MAX_XML_DEPTH + 1)), XmlSyntaxError);
  const wide = (count: number) => `<r>${"<a/>".repeat(count - 1)}</r>`;
  assert.equal(parseXml(wide(MAX_XML_ELEMENTS)).children.length, MAX_XML_ELEMENTS - 1);
  assert.throws(() => parseXml(wide(MAX_XML_ELEMENTS + 1)), XmlSyntaxError);
});
