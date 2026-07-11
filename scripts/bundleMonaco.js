#!/usr/bin/env node
// Bundle monaco-editor as a single IIFE that, when eval'd in any context,
// sets a private global API handle. We ship this file with the extension and
// inject it into the VSCode renderer via CDP Runtime.evaluate so the preview
// pane can instantiate a real Monaco editor without colliding with VS Code.
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const entry = path.join(root, 'scripts', 'monaco-entry.mjs');
const outDir = path.join(root, 'resources');
const outFile = path.join(outDir, 'monaco.bundle.js');
const cssFile = path.join(outDir, 'monaco.bundle.css');
const noticesFile = path.join(outDir, 'monaco.third-party-notices.txt');

if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

const result = esbuild.buildSync({
  entryPoints: [entry],
  bundle: true,
  format: 'iife',
  outfile: outFile,
  minify: true,
  target: 'chrome120',
  platform: 'browser',
  legalComments: 'none',
  loader: {
    '.ttf': 'dataurl',
    '.wasm': 'binary',
    // Keep Monaco's structural styles out of the workbench document. esbuild
    // emits them as a sibling CSS file; below we embed that text into the JS
    // bundle so the renderer patch can install it inside a ShadowRoot only.
    '.css': 'css',
  },
  // Language workers are intentionally not packaged into this renderer IIFE.
  // The core editor can fall back locally; workspace-aware language features
  // are relayed from VS Code's providers by the preview bridge.
  define: {
    'process.env.NODE_ENV': '"production"',
  },
});

if (!fs.existsSync(cssFile)) {
  throw new Error(`[bundleMonaco] expected emitted CSS at ${cssFile}`);
}
const cssText = fs.readFileSync(cssFile, 'utf8');
const javascript = fs.readFileSync(outFile, 'utf8');
// VS Code's workbench requires TrustedHTML and has already registered the
// Monaco policy names in its own realm. A second Monaco copy therefore cannot
// create `editorViewLayer` there. A hidden same-origin about:blank frame has a
// separate policy registry; TrustedHTML values are cross-realm branded, so its
// policies can safely serve the isolated preview without weakening workbench
// CSP or taking over a policy name used by VS Code itself.
const trustedTypesBootstrap = String.raw`
;(function(g){
  var state={installed:false};
  try {
    var previousFrame=g.__ijFindMonacoTrustedTypesFrame;
    try{if(previousFrame&&previousFrame.parentNode){previousFrame.parentNode.removeChild(previousFrame);}}catch(removeError){}
    var frame=document.createElement('iframe');
    frame.style.cssText='display:none!important;width:0;height:0;border:0';
    frame.setAttribute('aria-hidden','true');
    frame.setAttribute('data-ijss-monaco-trusted-types','true');
    (document.body||document.documentElement).appendChild(frame);
    g.__ijFindMonacoTrustedTypesFrame=frame;
    g.__ijFindMonacoTrustedTypesPolicies=Object.create(null);
    var childWindow=frame.contentWindow;
    var childTrustedTypes=childWindow&&childWindow.trustedTypes;
    if(!childTrustedTypes||typeof childTrustedTypes.createPolicy!=='function'){
      throw new Error('isolated Trusted Types registry unavailable');
    }
    // DOMPurify captures window.trustedTypes during module initialization and
    // creates its policy lazily, bypassing MonacoEnvironment. Temporarily
    // expose the child registry as an own Window property so that captured
    // reference remains isolated after we restore the workbench global.
    var trustedTypesDescriptor=Object.getOwnPropertyDescriptor(g,'trustedTypes');
    var hadOwnTrustedTypes=!!trustedTypesDescriptor;
    state.hadOwnTrustedTypes=hadOwnTrustedTypes;
    state.trustedTypesDescriptor=trustedTypesDescriptor;
    state.trustedTypesOverridden=false;
    Object.defineProperty(g,'trustedTypes',{
      configurable:true,
      enumerable:trustedTypesDescriptor?!!trustedTypesDescriptor.enumerable:false,
      value:childTrustedTypes
    });
    state.trustedTypesOverridden=true;
    if(g.trustedTypes!==childTrustedTypes){
      throw new Error('could not redirect bundled Trusted Types registry');
    }
    var priorEnv=g.MonacoEnvironment;
    var hadEnv=typeof priorEnv!=='undefined';
    var env=priorEnv&&typeof priorEnv==='object'?priorEnv:{};
    var hadOwnFactory=Object.prototype.hasOwnProperty.call(env,'createTrustedTypesPolicy');
    var priorFactory=env.createTrustedTypesPolicy;
    state.hadEnv=hadEnv;
    state.priorEnv=priorEnv;
    state.env=env;
    state.hadOwnFactory=hadOwnFactory;
    state.priorFactory=priorFactory;
    state.factoryOverridden=false;
    state.environmentAssigned=false;
    var policies=g.__ijFindMonacoTrustedTypesPolicies||(g.__ijFindMonacoTrustedTypesPolicies=Object.create(null));
    env.createTrustedTypesPolicy=function(name,options){
      var effectiveName=name==='standaloneColorizer'?'tokenizeToString':name;
      if(policies[effectiveName]){return policies[effectiveName];}
      try{
        policies[effectiveName]=childTrustedTypes.createPolicy(effectiveName,options);
        return policies[effectiveName];
      }catch(error){
        if(typeof priorFactory==='function'){
          return priorFactory.call(priorEnv,effectiveName,options);
        }
        throw error;
      }
    };
    state.factoryOverridden=true;
    g.MonacoEnvironment=env;
    state.environmentAssigned=true;
    state.installed=true;
  }catch(error){
    state.error=String(error&&error.message||error);
  }
  g.__ijFindMonacoTrustedTypesBootstrap=state;
})(globalThis);
`;
const trustedTypesRestore = String.raw`
;(function(g){
  var state=g.__ijFindMonacoTrustedTypesBootstrap;
  if(!state){return;}
  try{
    if(state.factoryOverridden){
      if(state.hadOwnFactory){state.env.createTrustedTypesPolicy=state.priorFactory;}
      else{delete state.env.createTrustedTypesPolicy;}
    }
    if(state.environmentAssigned){
      if(state.hadEnv){g.MonacoEnvironment=state.priorEnv;}
      else{delete g.MonacoEnvironment;}
    }
    if(state.trustedTypesOverridden){
      if(state.hadOwnTrustedTypes){Object.defineProperty(g,'trustedTypes',state.trustedTypesDescriptor);}
      else{delete g.trustedTypes;}
    }
  }catch(error){}
})(globalThis);
`;
fs.writeFileSync(
  outFile,
  `${trustedTypesBootstrap}\ntry {\n${javascript}\n` +
    `;globalThis.__ijFindMonacoCssText=${JSON.stringify(cssText)};\n` +
    `} finally {\n${trustedTypesRestore}\n}\n`,
  'utf8',
);
fs.unlinkSync(cssFile);

// node_modules is excluded from the VSIX, so copy Monaco's license and
// upstream third-party notices next to the generated bundle that we ship.
const monacoPackageDir = path.dirname(require.resolve('monaco-editor/package.json'));
const monacoLicense = fs.readFileSync(path.join(monacoPackageDir, 'LICENSE'), 'utf8');
const monacoNotices = fs.readFileSync(path.join(monacoPackageDir, 'ThirdPartyNotices.txt'), 'utf8');
const textMatePackageDir = path.dirname(require.resolve('vscode-textmate/package.json'));
const textMateLicense = fs.readFileSync(path.join(textMatePackageDir, 'LICENSE.md'), 'utf8');
const onigurumaPackageDir = path.dirname(require.resolve('vscode-oniguruma/package.json'));
const onigurumaLicense = fs.readFileSync(path.join(onigurumaPackageDir, 'LICENSE.txt'), 'utf8');
const onigurumaNotices = fs.readFileSync(path.join(onigurumaPackageDir, 'NOTICES.txt'), 'utf8');
fs.writeFileSync(
  noticesFile,
  `Monaco Editor license\n=====================\n\n${monacoLicense.trim()}\n\n` +
    `Monaco Editor third-party notices\n=================================\n\n${monacoNotices.trim()}\n\n` +
    `vscode-textmate license\n=======================\n\n${textMateLicense.trim()}\n\n` +
    `vscode-oniguruma license\n=========================\n\n${onigurumaLicense.trim()}\n\n` +
    `vscode-oniguruma notices\n=========================\n\n${onigurumaNotices.trim()}\n`,
  'utf8',
);

const stat = fs.statSync(outFile);
console.log(
  `[bundleMonaco] wrote ${outFile} — ${(stat.size / 1024).toFixed(0)} KB ` +
  `(including ${(cssText.length / 1024).toFixed(0)} KB isolated CSS)`,
);
if (result.warnings && result.warnings.length) {
  console.warn(`[bundleMonaco] ${result.warnings.length} warnings`);
}
