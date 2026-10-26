// Monaco's workers are inlined (`?worker&inline`), so the bundle is one file: it also runs where there is no site to fetch worker files from
import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/editor/editor.worker?worker&inline'
import jsonWorker from 'monaco-editor/language/json/json.worker?worker&inline'
import cssWorker from 'monaco-editor/language/css/css.worker?worker&inline'
import htmlWorker from 'monaco-editor/language/html/html.worker?worker&inline'
import tsWorker from 'monaco-editor/language/typescript/ts.worker?worker&inline'

declare global {
  var editor: monaco.editor.IStandaloneCodeEditor
  var monaco: any // eslint-disable-line no-var
}

globalThis.monaco = monaco
self.MonacoEnvironment = {
  getWorker(_, label) {
    if (label === 'json') return new jsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker()
    if (label === 'typescript' || label === 'javascript') return new tsWorker()
    return new editorWorker()
  }
}

export { monaco }
