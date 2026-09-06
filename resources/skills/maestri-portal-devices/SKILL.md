---
name: maestri-portal-devices
description: Drive an Android emulator or physical Android phone on the Maestri canvas. Tap, type, screenshot, read the accessibility tree, and launch apps. Use when the user asks to run or test a mobile app rather than a web page.
compatibility: Requires MAESTRI_WORKSPACE_ID and MAESTRI_SOCKET in a Maestri terminal.
user-invocable: true
---

# Maestri Android Device Automation

Before acting, verify that `MAESTRI_WORKSPACE_ID` and `MAESTRI_SOCKET` are both present without printing their values. If either is absent, stop because this skill is unavailable outside Maestri.

You're running inside Maestri, a spatial development workspace that connects AI agents, terminals, notes, and device portals on a visual canvas.
The `maestri` CLI is pre-installed and available on PATH. If `maestri` is not found, use `"$MAESTRI_CLI"` instead.

Device portals are embedded Android emulators or physical Android phones. You can tap, type, scroll, press hardware buttons, launch apps, take screenshots, and read the accessibility tree without requiring window focus.

Portal name is always required. Run `maestri list` to see connected portal names.

## Opening a device

`maestri portal devices` lists connected phones and running emulators, plus Android Virtual Devices managed by Android Studio.

`maestri portal create --simulator ID ["Name"]` opens a portal on a device and connects it to your terminal. Keep the `--simulator` spelling exactly as shown. Adopt a device marked free. Several portals can share one running device.

Android emulator creation, deletion, and resource settings belong in Android Studio. Maestri never overrides an AVD's CPU or memory settings. A physical phone must already have USB debugging enabled and authorize this host.

## Snapshot and refs

`maestri portal snapshot "Pixel"` is the most important command. It returns the frontmost app's accessibility tree with refs such as `@e1` and `@e2`:

```
app: com.example.app  screen: 1080x2424pt  elements: 3
@e1 text "Checkout" [420,90 240x60]
@e2 field "Search" [60,240 960x120] *focused*
@e3 button "Submit" [720,420 300x120]
```

The `pt` label is retained for wire compatibility. The numbers are Android device pixels. Commands accept an `@ref` from the latest snapshot or `x,y` coordinates. Screenshot coordinates use the emitted image's own dimensions and are normalized automatically.

## Commands

### Interaction
- `maestri portal click "Pixel" @e3` taps the element's center
- `maestri portal click "Pixel" 540,1200` taps coordinates
- `maestri portal type "Pixel" "hello world"` types into the focused field
- `maestri portal key "Pixel" Enter` presses a key
- `maestri portal key "Pixel" back` presses Android Back
- `maestri portal scroll "Pixel" down 400` swipe-scrolls up, down, left, or right
- `maestri portal swipe "Pixel" @e3 @e9` sends one completed swipe
- `maestri portal button "Pixel" home` presses a hardware button

Android navigation keys are `back`, `home`, `recents`, `menu`, `power`, `volumeup`, and `volumedown`. ADB delivers a drag only after release, so gestures that require holding mid-drag are not expressible.

### Apps and capture
- `maestri portal launch "Pixel" com.example.app` launches an installed package
- `maestri portal terminate "Pixel" com.example.app` stops a package
- `maestri portal navigate "Pixel" "https://example.com"` opens a URL through Android
- `maestri portal screenshot "Pixel"` captures a PNG and returns its temporary path
- `maestri portal info "Pixel"` reports device identity, runtime, state, and display size

`snapshot` can take about two seconds because it uses Android's `uiautomator`. Run it again after the screen changes to refresh refs. Prefer snapshot plus refs for interaction, and use screenshot for visual layout.

Browser-only verbs are not silently accepted on a device portal. Use snapshot or screenshot, then click, type, key, scroll, swipe, button, or launch.

## Recommended workflow

1. Run `maestri portal snapshot "Pixel"` to read the screen and get refs.
2. Interact with refs, coordinates, text, and keys.
3. Run snapshot again to verify the result.
4. Refresh the snapshot whenever refs become stale.

For Expo or React Native, pass the same device the portal reports from `maestri portal info "Pixel"` to the repository's Android run command. Android accessibility needs no injected agent and no special relaunch.
