// Entry point. Importing this side-effect-registers the custom elements
// and installs the global error router. Canvases that want the chrome
// just `import '/lib/liquidos-elements/index.js'`.

import './callback.js';
import './component.js';
import './file.js';
export { registerComponentScript, unregisterComponentScript, noteSuccessfulMount, reportComponentRuntimeError } from './error-router.js';
