# Chart Maker

A gig-chart maker for guitar that works on iPhone and iPad (or any browser). Type the chords for each section, and it draws a proper slash-notation chart. Charts are in the style of a session chart: repeats, 1st/2nd endings, segno/coda, accents, hairpins, and the odd bar of real notation. You can transpose a chart to any key, build a setlist for a gig, and export everything as one PDF.

## Using it

- **Songs → + New song.** Fill in the title, tempo, time signature and key, then type each section's bars:

  | Type this | You get |
  |---|---|
  | `E \| \| C#m \| \| A \| B/A` | bars separated by `\|`; an empty bar keeps the previous chord |
  | `A B/A` | two chords splitting a bar · `A . . B` = A for 3 beats, B on 4 |
  | `E >>` | accents on the first two slashes |
  | `B <` / `B dim` | crescendo / diminuendo hairpin |
  | `"Band out"` | text above the bar |
  | `segno` `coda` `ds` `dc` `ds-coda` `to-coda` `fine` `fermata` | road-map symbols |
  | `8ths` `quarters` `whole` | change the rhythm for one bar |
  | `A {e2 f g a4}` | a bar of real notation (ABC notes, eighth note = 1) |

  Each section has options for repeat, "play × times", 1st/2nd endings, a note under the first bar, bars per line, and "start on a new page".
- **Transpose** with the − / + buttons. The key signature, chords and any written notes all move.
- **Gigs → + New gig.** Add songs, put them in order, and transpose any song for that gig only. **PDF** makes one file with a setlist page and every chart.
- **PDF** → *Share / Save to Files / Print*, or use **Print** directly.

## Your data

Songs are saved in the browser on your device. Use **Settings & backup → Save backup file** now and then. Adding the app to your Home Screen keeps its data safe from Safari's automatic clean-up and makes it work offline.

## Hosting (GitHub Pages)

It's a static site with no build step. In the repository on GitHub, open **Settings → Pages**, set *Source: Deploy from a branch*, and pick the branch with folder `/ (root)`. Open the URL it gives you on the iPhone/iPad in Safari, then tap **Share → Add to Home Screen**.

To try it locally: `python3 -m http.server` in this folder, then open http://localhost:8000.

## Built with

- [abcjs](https://github.com/paulrosen/abcjs) (MIT) for music engraving
- [jsPDF](https://github.com/parallax/jsPDF) (MIT) for PDF output
- Fonts (SIL Open Font License): Patrick Hand SC, Stardos Stencil, Kalam

All of these are included in `vendor/` and `fonts/`, so the app works offline.
