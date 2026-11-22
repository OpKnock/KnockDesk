# Face Lock assets

Everything Face Lock needs at runtime, shipped inside the app. Nothing here is
fetched from the network, and nothing is loaded unless the user has turned
Face Lock on (Settings → Profile → App).

| File | What it is | Source | Licence |
| --- | --- | --- | --- |
| `face_landmarker.task` | MediaPipe Face Landmarker (float16, v1). Finds the face, places 478 points, reports how open each eye is. | `https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task` | Apache-2.0 |
| `sface.onnx` | OpenCV Zoo SFace (`face_recognition_sface_2021dec.onnx`). Turns an aligned 112×112 face into 128 numbers. 99.40% on LFW. | `https://huggingface.co/opencv/face_recognition_sface` | Apache-2.0 |
| `ort.wasm.bundle.min.js` | ONNX Runtime Web 1.30.0, `dist/ort.wasm.bundle.min.mjs` (renamed to `.js` so the app's static server sends it as JavaScript). | `https://registry.npmjs.org/onnxruntime-web/-/onnxruntime-web-1.30.0.tgz` | MIT |
| `ort-wasm-simd-threaded.wasm` | The WebAssembly binary that goes with it (same tarball, `dist/`). | same | MIT |
| `fonts/*.woff2` | Barlow Condensed 300–600 and JetBrains Mono 400/500 (latin), from Fontsource. | `@fontsource/barlow-condensed`, `@fontsource/jetbrains-mono` | OFL-1.1 |

SHA-256:

```
64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff  face_landmarker.task
0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79  sface.onnx
11e64bd8ffe11bd1a2a2f0d6275fdfbbba7262f0b76b99b53d228a8a22ef3d90  ort.wasm.bundle.min.js
3398c10d07d229bd91b364548e130e0e51a8e5704b88c7c083ebbeb78842dee2  ort-wasm-simd-threaded.wasm
```

## Notes for whoever updates these

- **Do not swap SFace for an InsightFace model** (`buffalo_*`, ArcFace
  `w600k_*`). Those weights are released for non-commercial research only.
- The ONNX Runtime bundle and its `.wasm` must come from the same release.
- `src/lib/facelock/engine.ts` loads the runtime with a `<script>` tag rather
  than `import()`, and passes only the `.wasm` URL (not a folder) so the
  runtime uses its built-in loader. Both are deliberate; the comments there
  explain why.
- The match threshold lives in `electron/services/facelock-core.js`. It was set
  from a measured gap (same person 0.51–0.83, different people ≤ 0.28 on the
  test set) — re-measure before changing the model.
