/**
 * The kit's Shiki instance — the ENGINE half of highlighting, which runs in
 * the highlight worker (worker.ts) and nowhere else: compiling a grammar is a
 * single synchronous task of up to ~650 ms (cpp), and no amount of scheduling
 * on the main thread keeps that from freezing the UI. highlighter.ts is the
 * main-thread client.
 *
 * Every grammar and the theme are imported STATICALLY, and the Oniguruma WASM
 * comes inlined: the worker is itself inlined into the plugin's one ESM file
 * (the host loads exactly one file per plugin), so nothing here may be a
 * separate asset or chunk. The weight lands in each consuming plugin's bundle
 * by design.
 *
 * Oniguruma, not the JS regex engine: it is the engine the grammars are
 * written for, and in the webview's JavaScriptCore the JS engine's cold
 * compile of a single line runs ~370 ms against Oniguruma's ~25 ms.
 *
 * No per-line time limit (`tokenizeTimeLimit: 0`). Shiki's default 500 ms
 * stops a line mid-scan and carries the rule stack it stopped in into the next
 * line — stopped just after a comment's opener, everything after reads as
 * comment until the next closer. Off the main thread a slow line costs only
 * time; limits.ts already keeps pathological input (huge files, minified
 * lines) from reaching the engine at all.
 *
 * Lazy singleton: nothing compiles until the first request.
 */
import {
  createHighlighterCore,
  type HighlighterCore,
} from "@shikijs/core";
import { createOnigurumaEngine } from "@shikijs/engine-oniguruma";
import getWasmInstance from "@shikijs/engine-oniguruma/wasm-inlined";
import themeOneDarkPro from "@shikijs/themes/one-dark-pro";
import langC from "@shikijs/langs/c";
import langCpp from "@shikijs/langs/cpp";
import langCsharp from "@shikijs/langs/csharp";
import langCss from "@shikijs/langs/css";
import langDiff from "@shikijs/langs/diff";
import langDocker from "@shikijs/langs/docker";
import langGo from "@shikijs/langs/go";
import langGraphql from "@shikijs/langs/graphql";
import langHtml from "@shikijs/langs/html";
import langIni from "@shikijs/langs/ini";
import langJava from "@shikijs/langs/java";
import langJavascript from "@shikijs/langs/javascript";
import langJson from "@shikijs/langs/json";
import langJsonc from "@shikijs/langs/jsonc";
import langJsx from "@shikijs/langs/jsx";
import langKotlin from "@shikijs/langs/kotlin";
import langLess from "@shikijs/langs/less";
import langLua from "@shikijs/langs/lua";
import langMake from "@shikijs/langs/make";
import langMarkdown from "@shikijs/langs/markdown";
import langObjectiveC from "@shikijs/langs/objective-c";
import langPerl from "@shikijs/langs/perl";
import langPhp from "@shikijs/langs/php";
import langPython from "@shikijs/langs/python";
import langRuby from "@shikijs/langs/ruby";
import langRust from "@shikijs/langs/rust";
import langScss from "@shikijs/langs/scss";
import langShellscript from "@shikijs/langs/shellscript";
import langSql from "@shikijs/langs/sql";
import langSvelte from "@shikijs/langs/svelte";
import langSwift from "@shikijs/langs/swift";
import langToml from "@shikijs/langs/toml";
import langTsx from "@shikijs/langs/tsx";
import langTypescript from "@shikijs/langs/typescript";
import langVue from "@shikijs/langs/vue";
import langXml from "@shikijs/langs/xml";
import langYaml from "@shikijs/langs/yaml";
import { alignTokens, type LineTokens } from "./tokens";

/** Every grammar the kit loads — the closed set `lang.ts` maps into. Each
 * module is a `LanguageRegistration[]` that already carries its embedded
 * dependencies (html brings js/css, markdown brings its fences' basics). */
const LANGS = [
  langC,
  langCpp,
  langCsharp,
  langCss,
  langDiff,
  langDocker,
  langGo,
  langGraphql,
  langHtml,
  langIni,
  langJava,
  langJavascript,
  langJson,
  langJsonc,
  langJsx,
  langKotlin,
  langLess,
  langLua,
  langMake,
  langMarkdown,
  langObjectiveC,
  langPerl,
  langPhp,
  langPython,
  langRuby,
  langRust,
  langScss,
  langShellscript,
  langSql,
  langSvelte,
  langSwift,
  langToml,
  langTsx,
  langTypescript,
  langVue,
  langXml,
  langYaml,
];

/** How every call tokenizes: the one theme, and no time limit (see above). */
const TOKENIZE = { theme: "one-dark-pro", tokenizeTimeLimit: 0 };

let instance: Promise<HighlighterCore> | null = null;

/** The instance, created on first use. A creation that fails is forgotten,
 * so the next request tries again instead of every one in the session
 * failing on the same cached rejection. */
function getHighlighter(): Promise<HighlighterCore> {
  instance ??= createHighlighterCore({
    langs: LANGS,
    themes: [themeOneDarkPro],
    engine: createOnigurumaEngine(getWasmInstance),
  }).catch((cause: unknown) => {
    instance = null;
    throw cause;
  });
  return instance;
}

/**
 * Tokenize `text` into per-line colored runs, aligned to `text.split("\n")`
 * (see tokens.ts for the alignment guarantees). `lang` may be a canonical id
 * (what `langFor` emits) or any grammar alias — "bash", "ts", "py" — which is
 * what a Markdown fence names. Returns null for a language the kit didn't
 * load — the caller renders plain, exactly as if `langFor` had said null in
 * the first place. Engine failures reject; the caller decides how loudly to
 * fall back.
 */
export async function tokenize(
  text: string,
  lang: string,
): Promise<LineTokens[] | null> {
  const highlighter = await getHighlighter();
  if (!isLoaded(highlighter, lang)) return null;
  const { tokens } = highlighter.codeToTokens(text, { lang, ...TOKENIZE });
  return alignTokens(text.split("\n"), tokens);
}

/** What a warm-up tokenizes. A grammar compiles its rules as the text first
 * reaches them, so a lone character pays only the root's share (cpp: ~300 of
 * ~650 ms): this mixes the constructs most grammars branch on — keywords,
 * calls, blocks, strings, numbers, both comment styles — in no one language's
 * syntax. */
const WARM_SAMPLE =
  'import x from "y";\n#include <z>\nfun main(a: int) { return f("s", 1.5) } // c\n/* b */ def g(): pass\n';

/**
 * Pay the highlighter's cold cost now rather than on the first file or diff
 * a person opens: the instance itself, then `lang`'s grammar when given. A
 * language the kit didn't load is a no-op, as in `tokenize`.
 */
export async function warm(lang: string | null): Promise<void> {
  const highlighter = await getHighlighter();
  if (lang === null || !isLoaded(highlighter, lang)) return;
  highlighter.codeToTokens(WARM_SAMPLE, { lang, ...TOKENIZE });
}

/** Whether `lang` resolves to a loaded grammar. `getLanguage` follows the
 * grammars' own alias table (`getLoadedLanguages` lists only canonical ids,
 * which would wrongly reject "bash" or "ts") and throws on a miss — the one
 * probe that treats ids and aliases uniformly. */
function isLoaded(highlighter: HighlighterCore, lang: string): boolean {
  try {
    highlighter.getLanguage(lang);
    return true;
  } catch {
    return false;
  }
}
