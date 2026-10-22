import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'

self.MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    if (label === 'json') return new JsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker()
    if (label === 'typescript' || label === 'javascript') return new TsWorker()
    return new EditorWorker()
  }
}

// The TypeScript service in the editor only sees the open files, not node_modules or the project's tsconfig.
// Without these settings every .tsx file reports "JSX is not enabled" and every import of an installed
// package is flagged as an unresolved module, which would bury the real problems.
const ts = monaco.languages.typescript
const compilerOptions: import('monaco-editor').languages.typescript.CompilerOptions = {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.NodeJs,
  jsx: ts.JsxEmit.ReactJSX,
  allowJs: true,
  allowNonTsExtensions: true,
  esModuleInterop: true,
  allowSyntheticDefaultImports: true,
  skipLibCheck: true
}
for (const defaults of [ts.typescriptDefaults, ts.javascriptDefaults]) {
  defaults.setCompilerOptions(compilerOptions)
  defaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
    // 2307/2792: cannot find module; 7016: no type declarations for a module; 2875/2686: JSX runtime / React in scope.
    diagnosticCodesToIgnore: [2307, 2792, 7016, 2875, 2686]
  })
}

export { monaco }
