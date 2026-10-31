/**
 * Every grammar the kit loads — the closed set `lang.ts` maps into, and the
 * engine (engine.ts) registers. Each module is a `LanguageRegistration[]`
 * that already carries its embedded dependencies (html brings js/css,
 * markdown brings its fences' basics). Imported STATICALLY, like everything
 * the engine loads: see engine.ts.
 */
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

export const GRAMMARS = [
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
