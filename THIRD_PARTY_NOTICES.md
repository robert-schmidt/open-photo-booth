# Third-party notices

Open Photo Booth's own code is MIT-licensed (see `LICENSE`). It ships with the components below, each under its own terms.

## In every build

| Component | Used for | Licence | Source |
|---|---|---|---|
| MediaPipe Tasks Vision 1.1.1 (`@mediapipe/tasks-vision`) | On-device face and person detection | Apache-2.0 | https://www.npmjs.com/package/@mediapipe/tasks-vision |
| MediaPipe Face Landmarker model (`models/face_landmarker.task`) | Glam, no-blink shots, face props, face-aware cropping | Apache-2.0 | https://storage.googleapis.com/mediapipe-assets/Model%20Card%20MediaPipe%20Face%20Mesh%20V2.pdf |
| MediaPipe Selfie Segmenter model (`models/selfie_segmenter.tflite`) | Background replacement | Apache-2.0 | https://storage.googleapis.com/mediapipe-assets/Model%20Card%20MediaPipe%20Selfie%20Segmentation.pdf |
| browser-inswapper (Chronic Qual SRL), bundled in `vendor/faceswap/` | On-device face swap | PolyForm Noncommercial 1.0.0 (`vendor/faceswap/LICENSE.md`) | https://github.com/robert-schmidt/browser-inswapper |
| ONNX Runtime Web 1.30.0 (in the face swap bundle) | Runs the face swap models on the GPU | MIT | https://www.npmjs.com/package/onnxruntime-web |
| MediaPipe Tasks Vision 0.10.35 (in the face swap bundle) | Face tracking for the face swap | Apache-2.0 | https://www.npmjs.com/package/@mediapipe/tasks-vision |

The library's video-file features, which use mediabunny (MPL-2.0), are left out of the bundle. Emoji stickers are drawn with the operating system's own emoji font; no emoji images are shipped.

## Face swap: not MIT

- **browser-inswapper** is published under the PolyForm Noncommercial licence, which does not allow commercial use.
- **The models** it needs, `inswapper_128` and `w600k_r50`, are InsightFace's, not this project's. They are not in the installers: the app downloads them from this project's GitHub releases when face swap is first turned on. InsightFace makes them "available for non-commercial research purposes only" and licenses other use itself: contact@insightface.ai (inswapper) and recognition-oss-pack@insightface.ai (the recognition models). See https://github.com/deepinsight/insightface#license.

Anyone using face swap at paid events needs the rights to do so from both.

## Only in builds made with the camera makers' SDKs

The SDKs themselves are not in this repository: their licence agreements allow their libraries to be distributed only as part of an application. A build made with them in `drivers/` ships these next to `camera-helper`.

| Component | Used for | Licence | Source |
|---|---|---|---|
| Sony Camera Remote SDK 2.02 (`Cr_Core` and its adapters) | Controls Sony cameras | Sony's Camera Remote SDK licence agreement | https://support.d-imaging.sony.co.jp/app/sdk/licenseagreement/en.html |
| libusb 1.0.26 (in Sony's SDK) | USB connection to Sony cameras | LGPL-2.1, as a separate library that can be replaced; Sony supplies its source with the SDK | https://libusb.info |
| libssh2 1.10.0 with OpenSSL 3.0.8 (in Sony's SDK) | Sony's network connection (the booth doesn't use it) | BSD-3-Clause; Apache-2.0 | https://libssh2.org, https://www.openssl.org |
| Nikon Remote SDK 2.1 for Z cameras (the TypeCommon module, NkPTPDriver2 and Royalmile) | Controls Nikon Z cameras | Nikon's SDK licence agreement | https://sdk.nikonimaging.com |
| Microsoft Visual C++ runtime (Windows only) | Needed by Sony's and Nikon's libraries | Microsoft's redistributable licence for Visual Studio | https://learn.microsoft.com/cpp/windows/latest-supported-vc-redist |

Terms that reach you as a user of such a build:

- **Sony.** Once a Sony camera has been used or controlled through this app, Sony no longer covers it under its manufacturer's warranty. Sony's software, this app and the cameras must not be used for the development, production or use of weapons or for military purposes. Sony is not the owner, licensor, creator or developer of Open Photo Booth and gives no support for it. The app asks you to agree to this before it first controls a camera.
- **Nikon.** Nikon's software is provided to you under the restrictions on use, limitations of liability and disclaimers of warranty of Nikon's SDK licence agreement, and Nikon is a third-party beneficiary of those terms. You may use it only as part of this app, and may not copy, modify, reverse engineer or redistribute it separately.
- Neither maker's trademark or copyright notices may be removed from their files.

Sony, Nikon and Canon are trademarks of their owners. Open Photo Booth is not affiliated with or endorsed by them.

## Tests only

`test/portrait.jpg`, the official White House portrait of Barack Obama (2012, public domain as a work of the US federal government), is used only by `npm run e2e` and is not shipped in the app.
