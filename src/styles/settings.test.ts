// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const settingsCss = readFileSync("src/styles/settings.css", "utf8");

/**
 * Apply every matching rule in source order for one viewport. A
 * scratch CSSStyleDeclaration resolves shorthand/longhand overrides, so a
 * later rule can never hide behind the first textual selector match.
 */
function effectiveDeclarations(
  selector: string,
  {
    css = settingsCss,
    width = 800,
    height = 500,
  }: { css?: string; width?: number; height?: number } = {},
): CSSStyleDeclaration {
  Object.defineProperties(window, {
    innerWidth: { configurable: true, value: width },
    innerHeight: { configurable: true, value: height },
  });
  const source = document.createElement("style");
  source.textContent = css;
  document.head.append(source);
  const effective = document.createElement("div").style;

  const visit = (rules: CSSRuleList) => {
    for (const rule of rules) {
      if (rule instanceof CSSMediaRule) {
        if (window.matchMedia(rule.conditionText).matches) visit(rule.cssRules);
        continue;
      }
      if (
        !(rule instanceof CSSStyleRule) ||
        !rule.selectorText
          .split(",")
          .map((candidate) => candidate.trim())
          .includes(selector)
      ) {
        continue;
      }
      for (let index = 0; index < rule.style.length; index += 1) {
        const property = rule.style.item(index);
        effective.setProperty(
          property,
          rule.style.getPropertyValue(property),
          rule.style.getPropertyPriority(property),
        );
      }
    }
  };

  visit(source.sheet!.cssRules);
  source.remove();
  return effective;
}

function viewportInset(value: string): number {
  const match = value.match(/100v[wh]\s*-\s*(\d+)px/);
  expect(match, `missing a viewport inset in ${value}`).not.toBeNull();
  return Number(match![1]);
}

/** CSSOM in happy-dom deliberately drops newer min() values. Read every
 * declaration of a viewport-bound property instead: any later override that
 * removes the gutter must fail, not hide behind the valid base rule. */
function declaredValues(selector: string, property: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rules = settingsCss.matchAll(
    new RegExp(`${escaped}\\s*\\{([^}]+)\\}`, "g"),
  );
  const propertyPattern = new RegExp(
    `(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`,
  );
  return [...rules].flatMap((match) => {
    const value = match[1].match(propertyPattern)?.[1].trim();
    return value ? [value] : [];
  });
}

describe("Settings layout", () => {
  it("bounds the whole surface at the minimum supported viewport", () => {
    const surface = effectiveDeclarations(".settings");
    expect(surface.boxSizing).toBe("border-box");
    expect(surface.maxWidth).toBe("none");
    for (const property of ["width", "height"]) {
      const values = declaredValues(".settings", property);
      expect(values.length).toBeGreaterThan(0);
      for (const value of values) {
        expect(viewportInset(value)).toBeGreaterThan(0);
      }
    }

    const body = effectiveDeclarations(".settings__body");
    expect(body.flexGrow).toBe("1");
    expect(body.flexShrink).toBe("1");
    expect(body.flexBasis).toBe("0%");
    expect(Number.parseFloat(body.minHeight)).toBe(0);
    expect(body.gridTemplateRows).toBe("minmax(0, 1fr)");
  });

  it("keeps non-zero breathing room in both scroll owners", () => {
    for (const selector of [".settings__nav", ".settings__section"]) {
      const declarations = effectiveDeclarations(selector);
      expect(Number.parseFloat(declarations.minHeight)).toBe(0);
      expect(declarations.overflowY).toBe("auto");
      expect(Number.parseFloat(declarations.paddingRight)).toBeGreaterThan(0);
      expect(Number.parseFloat(declarations.paddingBottom)).toBeGreaterThan(0);
    }
  });

  it("observes later matching overrides instead of blessing a stale first rule", () => {
    const declarations = effectiveDeclarations(".settings__section", {
      css: `${settingsCss}
        .settings__section {
          overflow-y: visible;
          padding-right: 0;
        }`,
    });
    expect(declarations.overflowY).toBe("visible");
    expect(declarations.paddingRight).toBe("0px");
  });
});
