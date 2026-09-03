# Wider rollout testing

## Supported test configuration

- Android Chrome on an ARCore-capable phone.
- The deployed HTTPS URL, not an embedded social-app browser.
- At least 250 MB of browser storage available.
- A static, textured, medium-sized subject at least 45 cm from the camera.
- Bright, even light and enough clear space to move around the subject safely.

Small close-range subjects are outside the calibrated web path. ARCore commonly fixes focus during WebXR and the web API cannot request autofocus or choose another lens.

## Before starting

1. Reload the deployed URL and record the build time shown below the app title.
2. Confirm the page reports Android WebXR and persistent local storage as available.
3. Remove private material from the scene background.
4. Select **Open camera**, center the object, and select **Start capture** only when positioned for the first view.

The app does not upload capture data. Images, depth, poses, and diagnostics stay in this browser's local storage until explicitly exported or deleted. The hosting provider still receives ordinary page-request metadata. An exported ZIP contains the scene background and must be shared privately.

## Capture protocol

1. Use the 12-sector **standard** ring for the main orbit. It represents the camera 5°–35° above the object, the natural position when a phone is held above the object and aimed slightly down.
2. Move to the blue/highlighted cell, stop, and hold. Do not continuously film the orbit.
3. Wait for two sharp frames, haptic confirmation, and an orange cell before moving.
4. Add the six low views by physically lowering the phone and aiming slightly upward.
5. Add the six raised views from 35°–60° above the subject.
6. Add one top view from above. Rotating around the same top position is unnecessary.
7. Return near the starting viewpoint to close the visual loop.
8. Finish only when all 25 required cells are orange and the result is **READY FOR SFM**.

Coverage is based on camera position relative to the estimated object. Merely tilting the phone without moving it does not add the parallax required by reconstruction.

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
