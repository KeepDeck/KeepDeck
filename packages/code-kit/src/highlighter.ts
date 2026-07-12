/**
 * The kit's one Shiki instance. Fine-grained core + the pure-JS regex engine
 * (no WASM asset to ship — a plugin bundle is one ESM file the host imports),
 * with every grammar and the theme imported STATICALLY: a dynamic import here
 * would make the plugin lib build emit code-split chunks next to index.js,
 * and the host loads exactly one file per plugin. The weight lands in each
 * consuming plugin's bundle by design (built-ins bundle independently; size
 * was explicitly accepted over a shared-runtime bridge).
 *
 * `forgiving: true` on the engine: a handful of Oniguruma patterns can't be
 * emulated in JS regexes; skipping those patterns costs a token of color in
 * exotic spots, while throwing would cost the whole file's highlighting.
 *
 * Lazy singleton: nothing compiles until the first `tokenizeLines` call, so
 * plugins that never show code (or a Files tab that's never opened) pay
 * nothing at activation.
 */
import {
  createHighlighterCore,
  type HighlighterCore,
} from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
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

const THEME = "one-dark-pro";

let instance: Promise<HighlighterCore> | null = null;

function getHighlighter(): Promise<HighlighterCore> {
  instance ??= createHighlighterCore({
    langs: LANGS,
    themes: [themeOneDarkPro],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
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
export async function tokenizeLines(
  text: string,
  lang: string,
): Promise<LineTokens[] | null> {
  const highlighter = await getHighlighter();
  if (!isLoaded(highlighter, lang)) return null;
  const { tokens } = highlighter.codeToTokens(text, { lang, theme: THEME });
  return alignTokens(text.split("\n"), tokens);
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
