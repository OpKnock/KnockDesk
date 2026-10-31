# public/videos

App के साथ जाने वाली videos यहाँ आती हैं। `electron-builder.yml` इस folder
को `resources/videos` में रखता है, और app उन्हें `knockdesk-media://` से
चलाती है (`src/lib/bundled-media.ts`, `electron/main.js` → `registerMediaProtocol`)।

इस वक़्त यहाँ कोई video नहीं। पुराना intro (`knockdesk start video.mp4`) 6 Oct 2026
को नए onboarding ("First Contact") के साथ हटा दिया गया — उस की जगह अब
`src/components/onboarding/scenes/WakeScene.tsx` है। Video git history में है।

यह फ़ाइल इस लिए है कि folder ख़ाली हो कर ग़ायब न हो जाए (build इसे ढूँढता है)।
