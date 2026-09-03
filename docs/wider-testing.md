# Wider rollout testing

## Supported test configuration

- Android Chrome on an ARCore-capable phone.
- The deployed HTTPS URL, not an embedded social-app browser.
- At least 250 MB of browser storage available.
- A static, textured, medium-sized subject at least 45 cm from the camera.
- Bright, even light and enough clear space to move around the subject safely.

Small close-range subjects are outside the calibrated WebXR path. The autofocus-only mode is available but uncalibrated. The XR-assisted autofocus option is a device/browser compatibility probe, not a supported baseline.

## Before starting

1. Reload the deployed URL and record the build time shown below the app title.
2. Confirm the page reports Android WebXR and persistent local storage as available.
3. Remove private material from the scene background.
4. Select **Open camera**, center the object, and select **Start capture** only when positioned for the first view.

The app does not upload capture data. Images, depth, poses, and diagnostics stay in this browser's local storage until explicitly exported or deleted. The hosting provider still receives ordinary page-request metadata. An exported ZIP contains the scene background and must be shared privately.

## Capture protocol

1. Use the 12-sector **standard** ring for the main orbit. It represents the camera 5°–35° above the object, the natural position when a phone is held above the object and aimed slightly down.
2. Move to the blue/highlighted cell, stop, and hold through the settling prompt. Do not continuously film the orbit.
3. After **VIEWPOINT 1 / 2**, take a small sideways step while remaining in the cell, stop, and hold again. The app requires at least 6° of object-relative separation.
4. Wait for haptic confirmation and an orange cell before advancing.
5. If CPU depth is available, confirm a blue surface constellation appears after the first accepted view, gains orange multi-view points after overlapping views, and rotates smoothly with the globe. Its absence on a depthless device is expected.
6. Add the six low cells by physically lowering the phone and aiming slightly upward.
7. Add the six raised cells from 35°–60° above the subject.
8. Add the top cell from two separated positions above the object.
9. Return near the starting viewpoint to close the visual loop.
10. Finish only when all 25 required cells are orange and the result is **READY FOR SFM**.

Coverage is based on camera position relative to the estimated object. Merely tilting the phone without moving it does not add the parallax required by reconstruction.

## XR-assisted autofocus probe

1. Record the build timestamp, then select **Try XR-assisted autofocus**.
2. If the app reports fallback, record the complete error. Confirm that the ordinary autofocus preview reopened and remains usable.
3. If it passes, confirm the HUD reports XR tracking `tracked`, nonzero XR FPS, autofocus stream `live`, and `continuous` or `single-shot` focus where supported.
4. Center the subject. If XR centre depth is unavailable, select the nearest camera-to-object-centre distance before starting. Start the photo scan, walk through at least four adjacent level sectors, and capture two views in each.
5. Confirm the globe follows physical position around the object, photographs fill the sector occupied at capture time, and tilting in place does not advance around the orbit.
6. Confirm close details are sharper than WebXR mode. Watch for focus hunting, a frozen preview, XR tracking loss, unexpected lens/FOV changes, or `takePhoto()` failure.
7. Finish and export the Archive ZIP. In `telemetry/photos.jsonl`, confirm each guided image has a coarse `captureGuidance` record with `poseSynchronized: false` and no camera matrix.

A passed startup probe does not establish full compatibility. A complete-orbit capture and downstream registration result are required before enabling this mode by default.

## Export and reconstruction

- **Spirula:** export the Spirula ZIP, extract it, choose **Create Dataset from Photos/Video**, and run native SfM before training.
- **LichtFeld:** export the LichtFeld ZIP, extract it, install `community:colmap` from LichtFeld's plugin browser if needed, choose the extracted `images` directory, and run sparse reconstruction before training. The plugin requires LichtFeld 0.5.0 or newer.
- **Full archive:** use this for engineering analysis. It preserves raw images, WebXR poses, quality decisions, depth, and visual-tracking evidence.

WebXR poses are guidance/provenance data. Neither destination package presents them as final reconstruction poses.

## Failure recovery

- The app marks the photos durable before deferred visual analysis. Once the UI says the capture is saved locally, leaving preserves the photos but may omit final connectivity checks.
- An interrupted capture appears in **Local captures**. Export it as a partial archive or delete it.
- Do not resume an interrupted capture after reopening WebXR. The new session has a different local coordinate frame.
- Export valuable captures before clearing Chrome site data. Persistent-storage protection reduces eviction risk but does not replace an external copy.

## Report a result

Select **Copy test report** and complete its problem, reproduction, expected, actual, and desktop-result fields. Send these through a private channel:

1. the completed report;
2. the relevant full Archive ZIP;
3. a screenshot of the capture UI or reconstruction;
4. the Spirula or LichtFeld registration count and visible failure mode.

Do not send a destination ZIP alone for capture-quality debugging; it intentionally omits much of the diagnostic evidence.
