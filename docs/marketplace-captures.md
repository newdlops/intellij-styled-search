# Marketplace captures

The overview in [README.md](../README.md) uses three short recordings and five still-image alternatives from the running desktop extension, in `resources/marketplace/`. Keep them synchronized with the contributed commands in `package.json` and the current renderer.

## Visual direction and acceptance

Show a developer evaluating one task at a time: search, scope, recall, edit, then usages. Keep VS Code's existing Dark Modern theme, match highlights, selection colors, and controls. Put short explanations in Markdown so they remain readable and accessible at any page width.

- Capture real search and graph results from the example workspace. Do not draw substitute controls, change result counts, or advertise benchmark timings from the fixture.
- Use a consistent panel crop that includes the query, Files scope, result list, preview path, and editor. The current exports are normalized to 2010 × 1288 PNGs; prefer a 2× display for crisp text.
- Wait for search and language-feature warmup to finish. Clear unrelated notifications. Keep the selected match and useful code context visible.
- Keep meaningful image alt text and relative image paths in the overview. Verify the assets are included by `vsce ls --no-dependencies`.
- Put animated GIFs inline, with separate MP4 playback and still-image links. Keep the animations short and silent; the stills provide a motion-free alternative.
- Separately exercise search execution, regex/scope filtering, keyboard history recall, editing/saving, and a usage-link click. A screenshot alone does not verify these behaviors.

## Prepare an isolated workspace

```bash
npm run compile
node scripts/prepareMarketplaceCapture.js
```

The script creates a disposable `taskboard` workspace and a separate VS Code profile under the OS temporary directory. It prints a `code` command that loads the current development extension without the user's installed extensions or preferences. Run that command, trust only the generated workspace, and close the secondary sidebar if it is open. No fixture data or profile needs to be checked in.

Open `src/scheduler.ts`, then run **IntelliJ Search: Force Rebuild Search + Graph Index**. Wait for completion and close the output panel. Open **IntelliJ Search: Search** and size the panel so the results and preview are both legible. The current captures use an approximately 1000 × 640 CSS-pixel panel, with the preview taking about half the height. Cropping coordinates depend on the host window and display scale.

## Capture sequence

| File | Actual interaction and expected visible state |
| --- | --- |
| `01-search.png` | Search `scheduleTask` with no scope and regex off. Select its declaration in `src/scheduler.ts`. Show 13 matches in 6 files and the function body. |
| `02-scope.png` | Set Files scope to `src/**, !**/*.test.ts`, query `schedule(Task\|Batch)`, and turn regex on. Show 10 matches in 3 files with tests excluded. |
| `03-history.png` | Also execute `scheduleBatch` and `pendingTasks`. Restore the unscoped literal `scheduleTask` search, select its declaration, open query History, and filter `schedule`. Show 3 of 4 entries. |
| `04-edit.png` | Close History. In the preview, change the default delay from `1000` to `1500`. Close any Find/Replace widget. Capture the modified indicator and enabled Save button before saving. Then click Save and verify the file on disk contains `1500` and the indicator clears. |
| `05-usages.png` | Click the `scheduleTask` usages inlay in the preview. Select a call in `src/workflows/daily.ts`; show confidence labels and its calling code. Use the actual graph results, even if their count changes in a later version. |

Query History restores text without running it. To check keyboard recall, select a different entry with the arrow keys and Enter, confirm the restored query waits for execution, then run it. Also recall the saved Files scope from its History menu and confirm it restores the complete include/exclude expression.

After refreshing the stills, inspect them at the width used by the Marketplace overview and in the VS Code Markdown preview. Check the page at narrow, medium, and wide widths for image scaling, table overflow, and caption wrapping. Keep text and command descriptions aligned with the implementation; detailed MCP and contributor documentation lives in the linked guides.

## Record short demos

Capture only the isolated Code example window with the computer-use tool's window screenshot API. Camera and microphone access are unnecessary. When capturing an occluded test workbench, the Chromium flags `--disable-renderer-backgrounding --disable-backgrounding-occluded-windows --disable-background-timer-throttling` keep its frames updating; apply them only to the disposable capture instance.

Use ordinary UI interactions and save successive screenshots as `frame-0000.jpg`, `frame-0001.jpg`, and so on in an OS temporary directory. Check the rendered screenshot as well as accessibility state before recording. Record the query before execution, the selected match, dirty edits, the completed save, and the usage-link click rather than fabricating intermediate controls or results. The current clips sample at 4 FPS and omit idle gaps between interaction bursts; they are demonstrations, not performance measurements. Retain the actual order of frames.

| Clip | Duration | GIF | MP4 | Recorded interaction |
| --- | --- | --- | --- | --- |
| `01-search` | 8.25 s | 243 KiB | 186 KiB | Enter `scheduleTask`, execute, then select the declaration. |
| `04-edit` | 7 s | 205 KiB | 142 KiB | Select `1000`, replace it with `1500`, click Save, and verify the modified indicator clears and disk content changes. |
| `05-usages` | 6.75 s | 474 KiB | 303 KiB | Click `usages 11`, open the actual cascading usage panel, and select the call in `daily.ts`. |

Encode the captured files with FFmpeg installed on the capture machine:

```bash
node scripts/encodeMarketplaceClip.js \
  --frames /tmp/ijss-clips/01-search \
  --name 01-search --out resources/marketplace \
  --crop 1014:654:214:60 --fps 4
```

The script reads only JPEG files and produces a looping GIF, an H.264 MP4 with no audio track, and a JSON size/duration report. It never opens a capture device. It rejects clips outside 2–15 seconds and GIFs above 2 MiB. The current search/edit crop is `1014:654:214:60`; usages uses `1052:692:214:60` to include the second panel. Recheck coordinates whenever the host window changes. Keep raw frames and capture timelines outside the repository.

Inspect decoded GIF frames for legible text, correct first/last states, clean crops, and palette artifacts. Verify the MP4's duration, dimensions, H.264 format, and lack of audio. Check the rendered README and its MP4/still links before packaging. Package with `vsce package --githubBranch <release-commit>` so Marketplace media links resolve to the release commit on `main2`, then verify the published media bytes against the verified VSIX.
