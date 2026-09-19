'use strict'
/**
 * Lists the voices Chromium's speechSynthesis can actually see.
 *   node_modules\.bin\electron.cmd scripts\list-voices.cjs
 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: true, // must be visible: Chromium initialises its TTS platform lazily
    width: 400,
    height: 300,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  })
  await win.loadURL('data:text/html,<html><body style="font:14px sans-serif">voices</body></html>')
  win.showInactive()

  // Chromium populates the voice list asynchronously.
  await new Promise((r) => setTimeout(r, 1500))
  const voices = await win.webContents.executeJavaScript(
    `new Promise((resolve) => {
       const grab = () => speechSynthesis.getVoices().map(v => ({
         name: v.name, lang: v.lang, local: v.localService, def: v.default, uri: v.voiceURI
       }));
       if (grab().length) return resolve(grab());
       speechSynthesis.addEventListener('voiceschanged', () => resolve(grab()), { once: true });
       setTimeout(() => resolve(grab()), 3000);
     })`,
    true
  )

  console.log(`\nChromium 可见语音总数: ${voices.length}\n`)
  const byLang = {}
  for (const v of voices) (byLang[v.lang] ||= []).push(v)
  for (const lang of Object.keys(byLang).sort()) {
    console.log(`[${lang}]  ${byLang[lang].length} 个`)
    for (const v of byLang[lang]) {
      console.log(`    ${v.local ? '本地' : '在线'}  ${v.name}${v.def ? '  (默认)' : ''}`)
    }
  }

  // Does speak() actually do anything, or does it silently no-op?
  const spoken = await win.webContents.executeJavaScript(
    `new Promise((resolve) => {
       const u = new SpeechSynthesisUtterance('测试一二三');
       u.lang = 'zh-CN';
       const t0 = Date.now();
       let started = false;
       u.onstart = () => { started = true };
       u.onend = () => resolve({ started, ms: Date.now() - t0, result: 'end' });
       u.onerror = (e) => resolve({ started, ms: Date.now() - t0, result: 'error: ' + e.error });
       speechSynthesis.speak(u);
       setTimeout(() => resolve({ started, ms: Date.now() - t0, result: 'timeout (never started)' }), 4000);
     })`,
    true
  )
  console.log(`\nspeak() 测试: ${JSON.stringify(spoken)}`)
  console.log(
    spoken.started
      ? '=> 系统语音可用'
      : '=> 系统语音不可用（Chromium 没有可用的 TTS 后端，会静默无声）'
  )
  console.log('')
  app.exit(0)
})
