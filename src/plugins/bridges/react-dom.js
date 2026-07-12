// The host's copy of "react-dom", re-exported so ui-kit primitives inside a
// built-in plugin can portal into the host document without bundling a second
// renderer. The production import map points the bare specifier here.
//
// ReactDOM ships CJS, so use the same explicit CJS-to-ESM bridge as the React
// and react-dom/client entries. Add another named export here when a plugin
// needs it; createPortal is the floating-layer surface today.
import ReactDOM from "react-dom";

export const { createPortal } = ReactDOM;
