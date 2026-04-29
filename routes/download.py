from __future__ import annotations
import io
import json
import re
import zipfile
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel

import config
from nyx_step import tracker, get_user_email

router = APIRouter()

_CHAPTER_IDS = ["starthere", "summary", "flowcharts", "scale", "midi", "analyze", "sampler", "lm", "presets", "radio", "extract", "quality", "lrc", "ch1", "ch2", "ch3", "ch4", "ch5", "ch6", "ch7", "ch8"]

_STYLE = (
    "<style>"
    "body{font-family:Arial,sans-serif;font-size:13px;color:#e2e4ed;background:#0b0c10;padding:12px;}"
    "h2{color:#7c65d9;border-left:4px solid #7c65d9;padding-left:8px;}"
    "h3{color:#00d4b6;} p,li{color:#e2e4ed;margin-bottom:6px;}"
    "table{border-collapse:collapse;width:100%;margin:8px 0;}"
    "th{background:#1a1c26;color:#00d4b6;padding:6px;border:1px solid #2d3041;}"
    "td{padding:6px;border:1px solid #2d3041;color:#e2e4ed;}"
    "code{background:#151720;color:#a6e3a1;padding:2px 4px;border-radius:3px;font-family:monospace;}"
    "pre{background:#151720;color:#cdd6f4;padding:10px;border-radius:6px;border:1px solid #2d3041;}"
    "</style>"
)

_FLOWCHARTS_HTML = (
    f"<html><head>{_STYLE}</head><body>"
    '<h2 style="color:#7c65d9;border-left:4px solid #7c65d9;padding-left:8px;margin-bottom:16px">Flowcharts</h2>'
    '<div style="margin-bottom:20px;text-align:center">'
    '<p style="color:#8a8f9e;font-size:12px;margin-bottom:8px">How Nyx-Step Works</p>'
    '<img src="/static/images/nyx-step-how-it-works.png" '
    'alt="How Nyx-Step Works" '
    'style="max-width:100%;border-radius:8px;border:1px solid #2d3041">'
    '</div>'
    '<div style="margin-bottom:20px;text-align:center">'
    '<p style="color:#8a8f9e;font-size:12px;margin-bottom:8px">How AI Creates Music From Static (Audio Diffusion Process)</p>'
    '<img src="/static/images/nyx-audio-diffusion.png" '
    'alt="How AI Creates Music From Static" '
    'style="max-width:100%;border-radius:8px;border:1px solid #2d3041">'
    '</div>'
    '<div style="margin-bottom:20px;text-align:center">'
    '<p style="color:#8a8f9e;font-size:12px;margin-bottom:8px">Nyx AI Music Keyword &amp; Tag Library</p>'
    '<img src="/static/images/nyx-keyword-library.png" '
    'alt="Nyx AI Music Keyword &amp; Tag Library" '
    'style="max-width:100%;border-radius:8px;border:1px solid #2d3041">'
    '</div>'
    "</body></html>"
)


_START_HERE_HTML = (
    f"<html><head>{_STYLE}</head><body>"
    '<h2 style="color:#7c65d9;border-left:4px solid #7c65d9;padding-left:8px;margin-bottom:16px">Start Here — Nyx-Step</h2>'

    '<div style="margin-bottom:20px;text-align:center">'
    '<img src="/static/images/nyx-start-here.png" alt="Nyx-Step overview" style="max-width:100%;border-radius:8px;border:1px solid #2d3041">'
    '</div>'

    '<p>Nyx-Step Nyx-Step is a browser-based AI music studio powered by ACE-Step v1.5 running on ComfyUI. '
    'It generates full audio — instruments, arrangement, and vocals — from text tags and lyrics. '
    'This guide covers every tab and feature.</p>'

    '<h3>Quick Start (60 seconds)</h3>'
    '<ol>'
    '<li>Go to the <strong>Style Infusor</strong> tab → pick a genre or type tags like <code>lo-fi hip hop, jazz piano, vinyl warmth, mellow, 85 BPM</code></li>'
    '<li>Go to <strong>Parameters</strong> → set Duration (30–60 s is a good first generation)</li>'
    '<li>Go to <strong>Overview</strong> → click <strong>🎵 Generate Music Idea</strong></li>'
    '<li>Wait ~30–60 s → a job card appears with a waveform player. Press ▶ to listen.</li>'
    '<li>Use 🔀 Remix → Variation or Repaint to refine the result</li>'
    '</ol>'

    '<h3>All Features at a Glance</h3>'
    '<table>'
    '<tr><th>Tab / Feature</th><th>What It Does</th><th>Guide</th></tr>'
    '<tr><td><strong>Overview</strong></td><td>Main generate button; live tags/payload preview; job cards with waveform player, download, remix, retake, quality score, LRC</td><td>—</td></tr>'
    '<tr><td><strong>Legion\'s BioInfusor</strong></td><td>AI tag expansion from plain-English description; artist/vocalist lookup; Ollama model selector</td><td>1. Philosophy</td></tr>'
    '<tr><td><strong>Style Infusor</strong></td><td>Genre browser (150+ genres); BPM/Key/Scale/Mode/Time-sig controls; chord progression; notes/melody hint</td><td>2. Tags, Scales &amp; Modes</td></tr>'
    '<tr><td><strong>Instruments</strong></td><td>Chip selector for all instrument categories; feeds directly into generation tags</td><td>2. Tags</td></tr>'
    '<tr><td><strong>Vocals</strong></td><td>8 vocal categories (tone, style, technique, range, emotion, arrangement, type, production)</td><td>2. Tags</td></tr>'
    '<tr><td><strong>Tagging</strong></td><td>Full lyrics editor; structural brackets; voice recorder → Whisper transcription</td><td>3. Lyrics</td></tr>'
    '<tr><td><strong>Parameters</strong></td><td>Steps, CFG, Duration, Batch Size, DiT model, Format, Language, Seed, LoRA (dual stacking)</td><td>—</td></tr>'
    '<tr><td><strong>Sampler</strong></td><td>Sampler (er_sde) + Scheduler (linear_quadratic) — controls diffusion character</td><td>Sampler</td></tr>'
    '<tr><td><strong>LM Stage toggle</strong></td><td>Enable/disable the Qwen LM pre-pass that generates audio codes before diffusion; improves coherence, adds ~10–30s overhead</td><td>LM Stage</td></tr>'
    '<tr><td><strong>Cover</strong></td><td>Upload reference audio → preserve melody, rewrite style. Inner tabs: Cover / Lego / Complete / Extract</td><td>6. Operations</td></tr>'
    '<tr><td><strong>📻 Radio</strong></td><td>Continuous AI stream — each segment inherits timbre from the previous; auto-chains indefinitely</td><td>📻 Radio</td></tr>'
    '<tr><td><strong>Analyze</strong></td><td>Auto-detect BPM, Key, Scale, LUFS, Chords, Language, Lyrics from any audio file</td><td>Analyze</td></tr>'
    '<tr><td><strong>Stems</strong></td><td>Demucs 4/6-stem separation; Nyx-Step diffusion-based stem extraction</td><td>6. Operations</td></tr>'
    '<tr><td><strong>MIDI</strong></td><td>Extract MIDI from audio — melody (pyin) or polyphonic piano (neural)</td><td>MIDI</td></tr>'
    '<tr><td><strong>Train LoRA</strong></td><td>Fine-tune a LoRA on your own audio dataset; real-time loss chart via SSE</td><td>—</td></tr>'
    '<tr><td><strong>Lint</strong></td><td>Validate tags/lyrics for bracket errors, duplicates, conflicts; auto-fix mode</td><td>—</td></tr>'
    '<tr><td><strong>History</strong></td><td>Searchable log of all generations; Load restores full state; Clear All removes history</td><td>—</td></tr>'
    '<tr><td><strong>Presets (.nyx)</strong></td><td>Save/load full generation state; export/import as .nyx files</td><td>Presets</td></tr>'
    '<tr><td><strong>📊 Quality Score</strong></td><td>Per-job 0–10 score: Loudness, Dynamics, Spectral, Saturation, Coherence</td><td>📊 Quality</td></tr>'
    '<tr><td><strong>🎵 LRC Lyrics</strong></td><td>Generate synchronized .lrc file for any job that has lyrics</td><td>🎵 LRC</td></tr>'
    '</table>'

    '<h3>Model Quick Reference</h3>'
    '<table>'
    '<tr><th>Model</th><th>Steps</th><th>CFG</th><th>Best For</th></tr>'
    '<tr><td>XL Turbo</td><td>8</td><td>2.0</td><td>Fast previews, Radio streaming, iteration</td></tr>'
    '<tr><td>XL SFT</td><td>30–50</td><td>7.0</td><td>Final quality, Cover mode, detailed arrangements</td></tr>'
    '<tr><td>XL Base</td><td>30–50</td><td>7.0</td><td>Lego/Complete/Extract modes; maximum structural control</td></tr>'
    '</table>'

    '<h3>The Core Idea: Tags + Lyrics = Music</h3>'
    '<p><strong>Tags</strong> describe the global sound — instruments, mood, tempo, era, production style. '
    'Think of tags as the arrangement brief: <em>what it sounds like from start to finish</em>.<br>'
    '<strong>Lyrics</strong> control the timeline — structural brackets like <code>[Verse]</code>, <code>[Chorus]</code>, <code>[Drop]</code> '
    'create sections. Actual sung lyrics go between the brackets. '
    'See the <strong>3. Lyrics</strong> and <strong>6. Operations</strong> guide chapters for full details.</p>'

    '<h3>Recommended First Workflow</h3>'
    '<ol>'
    '<li><strong>Analyze</strong> a reference track you like → hit Apply → BPM/key/chords populate automatically</li>'
    '<li>Browse <strong>Style Infusor</strong> genres to refine the style tags</li>'
    '<li><strong>Generate</strong> at 30 s with Turbo model (fast turnaround)</li>'
    '<li>Use <strong>Repaint</strong> on any section that needs work</li>'
    '<li>Use <strong>Extend</strong> to grow it to full song length</li>'
    '<li>Upload to <strong>Cover</strong> tab with a different style to transform the track</li>'
    '<li>Run <strong>Demucs</strong> in Stems tab to separate vocals/instruments</li>'
    '<li>Generate <strong>LRC</strong> if you added lyrics — download and load into your music player</li>'
    '</ol>'

    "</body></html>"
)


_SCALE_HTML = (
    f"<html><head>{_STYLE}</head><body>"
    '<h2 style="color:#7c65d9;border-left:4px solid #7c65d9;padding-left:8px;margin-bottom:16px">Scales &amp; Modes in Nyx-Step</h2>'

    '<h3>How It Works</h3>'
    '<p>Scale, Key, and Mode are injected as plain-text tags into the generation caption that Nyx-Step\'s Qwen language model reads. '
    'There is no hard-wired music-theory engine — the model interprets <code>C Blues</code> or <code>Phrygian mode</code> the same way '
    'a human musician would when reading a brief. This means <strong>any standard music-theory term Qwen understands will influence the output</strong>, '
    'but it does not guarantee that every note lands on that scale. Think of it as harmonic colour and mood shaping, not strict enforcement.</p>'
    '<p>Example caption fragment generated by the Style Infusor fields:</p>'
    '<pre>C Dorian mode, 120 BPM, 4/4, jazz piano trio, upbeat, swing</pre>'

    '<h3>Reliability by Category</h3>'
    '<table>'
    '<tr><th>Category</th><th>Examples</th><th>Reliability</th><th>Notes</th></tr>'
    '<tr><td>Standard</td><td>Major, Minor, Harmonic Minor, Melodic Minor</td><td style="color:#4caf50">High</td>'
    '<td>Core of Western music training data — very consistent effect on harmonic character</td></tr>'
    '<tr><td>Pentatonic / Blues</td><td>Pentatonic Minor, Blues, Blues Major</td><td style="color:#4caf50">High</td>'
    '<td>Extremely common in pop, rock, jazz training data; Blues gives that characteristic flat-3 / flat-7 feel</td></tr>'
    '<tr><td>Church Modes</td><td>Dorian, Phrygian, Lydian, Mixolydian, Aeolian, Locrian, Ionian</td><td style="color:#4caf50">High</td>'
    '<td>All seven modes appear extensively in music descriptions; each has a well-understood character the model reliably reproduces</td></tr>'
    '<tr><td>Symmetric</td><td>Whole Tone, Diminished, Chromatic</td><td style="color:#8bc34a">Good</td>'
    '<td>Strong presence in jazz and film scoring literature; Whole Tone gives dreamy/impressionist quality, Diminished adds tension</td></tr>'
    '<tr><td>Jazz Modes</td><td>Lydian Dominant, Super Locrian, Altered, Acoustic, Bebop Major/Dominant</td><td style="color:#8bc34a">Good</td>'
    '<td>Standard jazz vocabulary; Bebop and Altered are especially well represented in jazz training data</td></tr>'
    '<tr><td>World / Exotic</td><td>Hungarian Minor, Double Harmonic Major, Phrygian Dominant, Persian, Neapolitan</td><td style="color:#ff9800">Moderate</td>'
    '<td>Qwen knows these terms; audio training data coverage is sparser — effect on timbre and mood is real but subtler</td></tr>'
    '<tr><td>Ethnic Modes</td><td>Bhairav, Bhairavi, Yaman, Kafi, Hijaz</td><td style="color:#ff9800">Moderate</td>'
    '<td>Indian classical and Middle Eastern raga/maqam names; works best when combined with matching genre tags (e.g. <code>sitar, tabla, hindustani</code>)</td></tr>'
    '</table>'

    '<h3>Scale vs Mode — Which to Use</h3>'
    '<p>The Scale and Mode fields are independent — both get appended to the caption as separate tags. You can use one or both:</p>'
    '<ul>'
    '<li><strong>Scale only</strong> — use when you want the full scale character without specifying a diatonic mode. '
    'e.g. <code>C Blues</code>, <code>A Hungarian Minor</code></li>'
    '<li><strong>Mode only</strong> — use when the mode identity matters most. '
    'e.g. <code>Dorian mode</code>, <code>Phrygian mode</code></li>'
    '<li><strong>Both</strong> — can cause mild contradiction (e.g. <code>C Major</code> + <code>Dorian mode</code>). '
    'Generally safe if the scale and mode are compatible, but prefer one or the other when they overlap.</li>'
    '<li><strong>Neither</strong> — for genres where key/scale is implied by the style tags alone '
    '(e.g. <code>blues guitar</code> already implies a blues scale without stating it explicitly).</li>'
    '</ul>'

    '<h3>Scale Character Reference</h3>'
    '<table>'
    '<tr><th>Scale / Mode</th><th>Sound Character</th><th>Works Well With</th></tr>'
    '<tr><td>Major</td><td>Bright, resolved, happy</td><td>Pop, country, classical, upbeat EDM</td></tr>'
    '<tr><td>Natural Minor (Aeolian)</td><td>Dark, melancholic, emotional</td><td>Rock, metal, ballads, film scores</td></tr>'
    '<tr><td>Harmonic Minor</td><td>Exotic tension, dramatic resolution</td><td>Classical, flamenco, metal, Middle Eastern</td></tr>'
    '<tr><td>Melodic Minor</td><td>Smooth minor with lifted 6th &amp; 7th</td><td>Jazz, neo-classical, sophisticated R&amp;B</td></tr>'
    '<tr><td>Dorian</td><td>Minor but slightly brighter — cool, jazzy</td><td>Jazz, funk, blues-rock, Celtic, Daft Punk-style</td></tr>'
    '<tr><td>Phrygian</td><td>Dark, Spanish/flamenco, tense</td><td>Flamenco, metal, dark electronic, Middle Eastern</td></tr>'
    '<tr><td>Lydian</td><td>Dreamy, floating, otherworldly (raised 4th)</td><td>Film scores, synth pop, ambient, Sakamoto-style</td></tr>'
    '<tr><td>Mixolydian</td><td>Major with a flat 7 — bluesy, rock-ish</td><td>Blues, rock, Celtic, folk, classic rock</td></tr>'
    '<tr><td>Locrian</td><td>Unstable, dissonant, unsettling</td><td>Avant-garde, horror film, extreme metal</td></tr>'
    '<tr><td>Pentatonic Minor</td><td>Universal minor without tension tones</td><td>Blues, rock, pop, virtually any genre</td></tr>'
    '<tr><td>Pentatonic Major</td><td>Bright, open, simple</td><td>Folk, country, children\'s music, pop</td></tr>'
    '<tr><td>Blues</td><td>Soulful, expressive — pentatonic minor + flat 5</td><td>Blues, jazz, rock, R&amp;B, soul</td></tr>'
    '<tr><td>Whole Tone</td><td>Ambiguous, floating, impressionist</td><td>Film, ambient, Debussy-style, dream sequences</td></tr>'
    '<tr><td>Diminished</td><td>Tense, angular, horror or jazz</td><td>Jazz (over dom7b9), horror, avant-garde</td></tr>'
    '<tr><td>Hungarian Minor</td><td>Exotic, Eastern European, dramatic</td><td>Folk, metal, film, world music</td></tr>'
    '<tr><td>Phrygian Dominant</td><td>Spanish / Middle Eastern (Phrygian #3)</td><td>Flamenco, Middle Eastern, surf guitar</td></tr>'
    '<tr><td>Lydian Dominant</td><td>Lydian with flat 7 — bright yet funky</td><td>Jazz fusion, film, Lydian-flavoured rock</td></tr>'
    '<tr><td>Super Locrian (Altered)</td><td>Maximum dissonance — jazz tension</td><td>Over dominant chords in jazz</td></tr>'
    '<tr><td>Bebop Dominant</td><td>Mixolydian + passing tone — swinging</td><td>Jazz, bebop, swing</td></tr>'
    '<tr><td>Hijaz</td><td>Arabic/Middle Eastern character</td><td>World music, fusion, film</td></tr>'
    '</table>'

    '<h3>Tips for Best Results</h3>'
    '<ul>'
    '<li>Combine scale/mode with matching genre tags — <code>C Dorian mode, jazz, electric piano</code> is stronger than the scale alone</li>'
    '<li>The Chord Progression field reinforces scale choices — a <code>i - VI - III - VII</code> progression with <code>Dorian mode</code> is very effective</li>'
    '<li>For ethnic scales (Bhairav, Hijaz, Persian), always pair with cultural instrument tags for the model to anchor the sound</li>'
    '<li>Locrian and Super Locrian rarely sound "right" as a whole-piece scale — best used for short passages or extreme tension effects</li>'
    '<li>If outputs sound harmonically wrong, try dropping the mode field and letting the genre tags carry the harmonic character</li>'
    '</ul>'
    "</body></html>"
)


_MIDI_HTML = (
    f"<html><head>{_STYLE}</head><body>"
    '<h2 style="color:#7c65d9;border-left:4px solid #7c65d9;padding-left:8px;margin-bottom:16px">MIDI Extraction</h2>'

    '<h3>What It Does</h3>'
    '<p>The MIDI tab converts audio recordings into MIDI files you can load directly into any DAW (Ableton, FL Studio, Logic, Reaper). '
    'Two extraction engines are available depending on the source material:</p>'
    '<table>'
    '<tr><th>Mode</th><th>Engine</th><th>Best For</th><th>Output</th></tr>'
    '<tr><td><strong>Melody</strong></td><td>librosa pyin</td>'
    '<td>Any single melodic instrument — vocals, guitar, violin, flute, synth lead</td>'
    '<td>Monophonic MIDI — one note at a time</td></tr>'
    '<tr><td><strong>Piano</strong></td><td>Piano Transcription Inference (neural)</td>'
    '<td>Piano recordings — acoustic and electric</td>'
    '<td>Polyphonic MIDI — full chord and voice detection</td></tr>'
    '</table>'

    '<h3>Melody Mode — Tips</h3>'
    '<ul>'
    '<li>Works on any monophonic (single-note) source — it uses pitch detection (pyin), not note onset prediction</li>'
    '<li>Set the <strong>BPM</strong> field to the tempo of the audio before extracting — use the Analyze tab to auto-detect BPM first</li>'
    '<li>Very quiet or heavily reverbed recordings may produce extra short spurious notes — these can be cleaned up in your DAW</li>'
    '<li>Notes shorter than 50 ms are automatically filtered to reduce noise</li>'
    '<li>Background harmony, chords, or other instruments are ignored — only the dominant pitch is tracked</li>'
    '</ul>'

    '<h3>Piano Mode — Tips</h3>'
    '<ul>'
    '<li>Uses a GPU-accelerated neural model trained specifically on piano recordings</li>'
    '<li>Works best on dry or lightly reverbed piano — heavy processing or mixed-down tracks may produce extra ghost notes</li>'
    '<li>BPM is not required for piano mode — the model works in real time without a tempo reference</li>'
    '<li>Full polyphony: chords, bass lines, and treble melody are all captured simultaneously</li>'
    '<li>Output MIDI velocity reflects note loudness from the audio</li>'
    '</ul>'

    '<h3>Workflow</h3>'
    '<ol>'
    '<li>Go to the <strong>Analyze</strong> tab and upload the audio — note the detected BPM</li>'
    '<li>Switch to the <strong>MIDI</strong> tab, select Mode and enter the BPM if using Melody mode</li>'
    '<li>Upload the same audio file and click <strong>Extract MIDI</strong></li>'
    '<li>Download the .mid file and import it into your DAW</li>'
    '<li>Quantize in your DAW if needed — pyin outputs raw timing, not quantized to a grid</li>'
    '</ol>'

    '<h3>What To Do With The MIDI</h3>'
    '<ul>'
    '<li><strong>Re-orchestrate</strong> — trigger any soft-synth or sample library with the extracted melody</li>'
    '<li><strong>Transpose</strong> — move the melody to a different key for remixing</li>'
    '<li><strong>Chord detection</strong> — use the MIDI piano roll to see what chords the AI generated, then build a real arrangement</li>'
    '<li><strong>Feed back to Nyx-Step</strong> — use extracted note data to write better chord progression tags for the next generation</li>'
    '</ul>'
    "</body></html>"
)


_ANALYZE_HTML = (
    f"<html><head>{_STYLE}</head><body>"
    '<h2 style="color:#7c65d9;border-left:4px solid #7c65d9;padding-left:8px;margin-bottom:16px">Analyze Audio</h2>'

    '<h3>What It Measures</h3>'
    '<p>Upload any audio file to the Analyze tab to extract the following automatically:</p>'
    '<table>'
    '<tr><th>Measurement</th><th>Method</th><th>Use In Generation</th></tr>'
    '<tr><td><strong>BPM</strong></td><td>Energy onset peak detection (scipy)</td><td>Apply → sets BPM field; use as tempo anchor</td></tr>'
    '<tr><td><strong>Key + Scale</strong></td><td>Krumhansl-Schmuckler chromagram correlation</td><td>Apply → sets Key and Scale dropdowns</td></tr>'
    '<tr><td><strong>LUFS</strong></td><td>ITU-R BS.1770-4 integrated loudness (pyloudnorm)</td><td>Reference only — useful for mastering context</td></tr>'
    '<tr><td><strong>Chord Progression</strong></td><td>Librosa chroma_stft + major/minor chord templates</td><td>Apply → sets Chord Progression field</td></tr>'
    '<tr><td><strong>Duration</strong></td><td>Sample count / sample rate</td><td>Reference — set generation Duration to match</td></tr>'
    '<tr><td><strong>Language + Lyrics</strong></td><td>faster-whisper ASR (base model, VAD filtered)</td><td>Apply → sets Lyrics field and Language dropdown</td></tr>'
    '</table>'

    '<h3>LUFS — What It Means</h3>'
    '<ul>'
    '<li>LUFS = Loudness Units relative to Full Scale — the broadcast/streaming loudness standard</li>'
    '<li>Typical targets: Streaming (Spotify/Apple Music) = <code>-14 LUFS</code>; CD masters = <code>-9 LUFS</code>; Film/TV = <code>-24 LUFS</code></li>'
    '<li>Nyx-Step outputs typically come in at <code>-14</code> to <code>-18 LUFS</code> — no action needed for streaming</li>'
    '<li>If a reference track you\'re analyzing is much louder or quieter than the AI output, that difference is visible here</li>'
    '</ul>'

    '<h3>Chord Detection — Tips</h3>'
    '<ul>'
    '<li>Detection is based on chromagram energy — works best on recordings with clear harmonic content (piano, guitar, keys)</li>'
    '<li>Heavily distorted or percussive recordings may produce noisy chord reads — treat output as a starting suggestion</li>'
    '<li>The Apply button writes the detected chords directly into the Chord Progression field; edit manually if needed</li>'
    '<li>Only major and minor chords are detected — extended chords (7ths, 9ths, sus) will be mapped to their closest major/minor</li>'
    '</ul>'

    '<h3>Workflow: Reference Track → Cover</h3>'
    '<ol>'
    '<li>Upload a reference track in the Analyze panel</li>'
    '<li>Click Analyze — note BPM, Key, Scale, detected chords, and LUFS</li>'
    '<li>Click <strong>✓ Apply</strong> — populates BPM, Key, Scale, Chord Progression, Language, and Lyrics into state</li>'
    '<li>Adjust tags to describe the target style (genre, mood, instruments)</li>'
    '<li>Switch to Cover tab — upload the same reference track</li>'
    '<li>Generate — Nyx-Step will preserve the reference melody while applying your new tags</li>'
    '</ol>'
    "</body></html>"
)


_SAMPLER_HTML = (
    f"<html><head>{_STYLE}</head><body>"
    '<h2 style="color:#7c65d9;border-left:4px solid #7c65d9;padding-left:8px;margin-bottom:16px">Sampler &amp; Scheduler</h2>'

    '<h3>What These Control</h3>'
    '<p>The <strong>Sampler</strong> and <strong>Scheduler</strong> dropdowns in the Sampler tab control how Nyx-Step\'s diffusion process '
    'moves from noise to music. Different combinations produce different sonic character even with identical prompts.</p>'

    '<h3>Recommended Settings</h3>'
    '<table>'
    '<tr><th>Setting</th><th>Default</th><th>Why</th></tr>'
    '<tr><td>Sampler</td><td><code>er_sde</code></td>'
    '<td>Nyx-Step sweet spot — smooth transitions, musical phrasing, fewer artifacts than Euler at low step counts</td></tr>'
    '<tr><td>Scheduler</td><td><code>linear_quadratic</code></td>'
    '<td>Better pitch stability and tonal clarity than linear; consistently outperforms Karras for music generation</td></tr>'
    '</table>'

    '<h3>Sampler Reference</h3>'
    '<table>'
    '<tr><th>Sampler</th><th>Character</th><th>Best For</th></tr>'
    '<tr><td>er_sde</td><td>Smooth, musical, low artifacts</td><td>All use cases — primary recommendation</td></tr>'
    '<tr><td>euler</td><td>Clean, deterministic</td><td>Debugging; fast previews at 8–20 steps</td></tr>'
    '<tr><td>euler_ancestral</td><td>Adds stochastic variation</td><td>Experimental; more diversity per seed</td></tr>'
    '<tr><td>dpmpp_2m</td><td>Efficient, sharp</td><td>Quality at 20–30 steps with SFT/Base model</td></tr>'
    '<tr><td>dpmpp_sde</td><td>Stochastic DPM++</td><td>More variation than dpmpp_2m; slower</td></tr>'
    '<tr><td>heun</td><td>High accuracy, slow</td><td>Maximum quality at 40–50 steps</td></tr>'
    '<tr><td>lcm</td><td>Very fast, low quality</td><td>Ultra-fast previews (4–8 steps)</td></tr>'
    '</table>'

    '<h3>Scheduler Reference</h3>'
    '<table>'
    '<tr><th>Scheduler</th><th>Character</th><th>Best For</th></tr>'
    '<tr><td>linear_quadratic</td><td>Pitch-stable, tonally clear</td><td>Primary recommendation — all use cases</td></tr>'
    '<tr><td>linear</td><td>Simple uniform spacing</td><td>Baseline reference; sometimes sounds flat</td></tr>'
    '<tr><td>karras</td><td>Front-loaded, detailed</td><td>Quality with SFT/Base model at 30+ steps</td></tr>'
    '<tr><td>exponential</td><td>Back-loaded denoising</td><td>Experimental — can improve low-freq clarity</td></tr>'
    '<tr><td>simple</td><td>Minimal</td><td>Fastest convergence, lowest overhead</td></tr>'
    '</table>'

    '<h3>Steps + Model Interaction</h3>'
    '<ul>'
    '<li><strong>XL Turbo</strong>: 8 steps is enough — more steps with Turbo rarely helps, can hurt. Use er_sde + linear_quadratic.</li>'
    '<li><strong>XL SFT / Base</strong>: 30–50 steps. Try dpmpp_2m + karras for maximum detail, or er_sde + linear_quadratic for safe quality.</li>'
    '<li>CFG scale interacts with sampler: er_sde handles CFG 2.0 cleanly; euler_ancestral may need lower CFG (1.5) to avoid artifacts.</li>'
    '</ul>'
    "</body></html>"
)


_PRESETS_HTML = (
    f"<html><head>{_STYLE}</head><body>"
    '<h2 style="color:#7c65d9;border-left:4px solid #7c65d9;padding-left:8px;margin-bottom:16px">Presets &amp; .nyx Files</h2>'

    '<h3>What Is a Preset?</h3>'
    '<p>A preset captures the full generation state — BPM, key, scale, mode, chord progression, instruments, vocal tags, '
    'lyrics, and all Parameters tab values (steps, CFG, duration, sampler, seed, LoRA, etc.) — into a single named snapshot. '
    'Presets are stored as <code>.nyx</code> JSON files on the server and can be exported as local files or imported from disk.</p>'

    '<h3>Save a Preset</h3>'
    '<ol>'
    '<li>Open the preset modal via the 📂 Load/Save Preset button (Overview tab)</li>'
    '<li>Type a name in the "Preset name…" field</li>'
    '<li>Click 💾 Save — the preset is written to the server as <code>name.nyx</code></li>'
    '</ol>'

    '<h3>Load a Preset</h3>'
    '<ol>'
    '<li>Open the preset modal</li>'
    '<li>Click a preset name in the list — all fields are immediately restored</li>'
    '<li>The generation state updates live; Overview tags and Payload Preview reflect the change instantly</li>'
    '</ol>'

    '<h3>Export a Preset as a File</h3>'
    '<ul>'
    '<li><strong>Export current state</strong>: click <em>⬇ Export .nyx</em> in the preset modal — downloads the current state as a file without saving to server first</li>'
    '<li><strong>Export saved preset</strong>: click the <em>⬇</em> button next to any preset in the list — downloads that specific preset</li>'
    '<li>The file is a standard JSON file with a <code>.nyx</code> extension — open in any text editor</li>'
    '</ul>'

    '<h3>Import a Preset from File</h3>'
    '<ol>'
    '<li>Click <em>⬆ Import .nyx</em> in the preset modal</li>'
    '<li>Choose a <code>.nyx</code> file from disk</li>'
    '<li>The preset is applied to the current state immediately and also saved to the server under the preset\'s <code>song_name</code></li>'
    '</ol>'

    '<h3>Dual LoRA Stacking</h3>'
    '<p>The Parameters tab has two LoRA slots. When both are set, they are chained in series: '
    'LoRA 1 output feeds into LoRA 2. The workflow becomes: '
    '<code>UNETLoader → LoraLoader1 → LoraLoader2 → Sampler</code>. '
    'Both LoRA scale sliders (0–2.0) control their respective influence independently.</p>'
    '<ul>'
    '<li>Use LoRA 1 for style (e.g. "jazz_feel_v2.safetensors") and LoRA 2 for texture (e.g. "vinyl_warmth.safetensors")</li>'
    '<li>Scales above 1.0 increase influence; below 1.0 blends gently. Start at 0.7–0.8 each when stacking.</li>'
    '<li>If output sounds wrong, try disabling one LoRA (set to None) to isolate which one is causing the issue</li>'
    '<li>Preset save/load includes LoRA name and scale for both slots</li>'
    '</ul>'
    "</body></html>"
)


_RADIO_HTML = (
    f"<html><head>{_STYLE}</head><body>"
    '<h2 style="color:#7c65d9;border-left:4px solid #7c65d9;padding-left:8px;margin-bottom:16px">📻 Continuous AI Radio</h2>'

    '<h3>What It Does</h3>'
    '<p>Radio mode generates an endless stream of music by chaining Nyx-Step generations. Each completed segment is automatically fed back '
    'as a timbre reference for the next, so the stream stays sonically coherent while evolving creatively over time. '
    'You can let it run in the background indefinitely — new segments queue automatically.</p>'

    '<h3>How It Works</h3>'
    '<ol>'
    '<li><strong>Segment 0</strong> — generated fresh from your tags with no reference (standard generation workflow)</li>'
    '<li><strong>Segments 1+</strong> — each uses the previous segment\'s audio as <code>ReferenceTimbreAudio</code> timbre input plus a fresh '
    '<code>EmptyAceStep1.5LatentAudio</code> target; denoise = 1.0 (full generation, new audio codes each time)</li>'
    '<li>A background watcher thread monitors ComfyUI job status every 3 s; on completion it copies the output to ComfyUI\'s input dir and submits the next segment</li>'
    '<li>The browser receives new segment events over SSE (<code>GET /radio/events</code>) and queues them for playback automatically</li>'
    '</ol>'

    '<h3>Controls</h3>'
    '<table>'
    '<tr><th>Control</th><th>Purpose</th></tr>'
    '<tr><td>Tags</td><td>Style tags for all segments — same prompt is used throughout the stream</td></tr>'
    '<tr><td>BPM / Key / Scale</td><td>Tempo and harmonic anchor — kept consistent across segments via the timbre reference</td></tr>'
    '<tr><td>Duration</td><td>Length of each segment in seconds (10–120 s recommended; shorter = faster turnaround)</td></tr>'
    '<tr><td>Steps</td><td>Diffusion steps per segment — 20 is a good balance; fewer = faster generation</td></tr>'
    '<tr><td>📻 Start / ⏹ Stop</td><td>Start begins segment 0 immediately; Stop halts the queue after the current segment finishes generating</td></tr>'
    '</table>'

    '<h3>Playback</h3>'
    '<ul>'
    '<li>Segments play back-to-back automatically; if the next segment isn\'t ready yet, the player shows "Generating next segment…"</li>'
    '<li>History panel lists all completed segments; click ▶ on any entry to replay it; ⬇ link downloads the file</li>'
    '<li>🗑 Clear button in the history panel removes the displayed list without stopping the stream — new segments continue to appear as they complete</li>'
    '<li>Output files are named <code>Nyx_radio_XXXXX_.mp3</code> and saved alongside regular generations in the audio output directory</li>'
    '<li>If you refresh the page while radio is running, the status reconnects automatically via <code>GET /radio/status</code></li>'
    '</ul>'

    '<h3>Settings Tip</h3>'
    '<ul>'
    '<li>Use <strong>XL Turbo model</strong> (8 steps) for minimal latency — segments complete in ~30 s per 30 s of audio</li>'
    '<li>Keep Duration ≤ 45 s so the next segment is almost always ready before the current one ends</li>'
    '<li>Sampler er_sde + Scheduler linear_quadratic (Parameters tab defaults) work well for continuous streams</li>'
    '<li>Tags can be anything — lo-fi, ambient drone, jazz trio, energetic EDM; the timbre chain preserves sonic character even as random seeds change</li>'
    '</ul>'
    "</body></html>"
)


_EXTRACT_HTML = (
    f"<html><head>{_STYLE}</head><body>"
    '<h2 style="color:#7c65d9;border-left:4px solid #7c65d9;padding-left:8px;margin-bottom:16px">Extract Mode — Single Stem Isolation</h2>'

    '<h3>What It Does</h3>'
    '<p>Extract Mode uses Nyx-Step\'s <code>ReferenceTimbreAudio</code> node to isolate or heavily emphasize a single sonic element from a '
    'mixed audio file. Unlike Demucs (which uses a dedicated trained separator), Extract Mode works by guiding the diffusion model to '
    'regenerate the audio while attending closely to one instrument\'s timbre — controlled entirely through your style tags.</p>'

    '<h3>When To Use It</h3>'
    '<table>'
    '<tr><th>Goal</th><th>Approach</th></tr>'
    '<tr><td>Isolate a vocal line from a generated track</td><td>Upload the track; use tags like <code>isolated vocals, a cappella, no instruments</code></td></tr>'
    '<tr><td>Emphasize guitar melody in a full mix</td><td>Tags: <code>solo guitar, guitar melody, minimal, no drums, no bass</code></td></tr>'
    '<tr><td>Create a clean instrumental bed</td><td>Tags: <code>instrumental, no vocals, ambient background</code></td></tr>'
    '<tr><td>Isolate a specific texture</td><td>Tags: <code>synth pad only, atmospheric, spacious</code></td></tr>'
    '</table>'

    '<h3>How It Works</h3>'
    '<p>The workflow uses <code>generate_audio_codes=false</code> (skips the Qwen LM stage — no new melodic/harmonic codes are generated) '
    'and a high denoise value (default 0.98) which almost fully re-synthesises the audio. The <code>ReferenceTimbreAudio</code> node '
    'anchors the timbre to the uploaded file while your tags steer what gets reconstructed. The result is a version of the audio '
    'filtered through the lens of your style description.</p>'

    '<h3>Parameters</h3>'
    '<table>'
    '<tr><th>Parameter</th><th>Default</th><th>Effect</th></tr>'
    '<tr><td>Denoise</td><td>0.98</td><td>How much the audio is re-synthesised. 0.98 = aggressive; try 0.7–0.85 for gentler extraction</td></tr>'
    '<tr><td>Steps</td><td>30</td><td>Higher steps = more refined extraction; 30–50 recommended for SFT/Base models</td></tr>'
    '<tr><td>CFG</td><td>7.0</td><td>Higher CFG = stronger adherence to tags; 7.0 works well for extraction</td></tr>'
    '<tr><td>Duration</td><td>auto</td><td>Set to match source audio length</td></tr>'
    '</table>'

    '<h3>vs. Demucs Separation</h3>'
    '<ul>'
    '<li><strong>Demucs</strong> — trained source separator; deterministic; produces 4–6 stems (vocals/drums/bass/other); best for standard separation</li>'
    '<li><strong>Extract Mode</strong> — diffusion-guided; creative; can target any description (not just fixed stems); produces one output; best when you want a specific sonic quality, not a fixed instrument track</li>'
    '<li>Use Demucs first if you want a clean vocal or drums track. Use Extract when Demucs doesn\'t give you what you want, or when you\'re targeting a texture rather than an instrument.</li>'
    '</ul>'

    '<h3>Model Recommendation</h3>'
    '<p>Use the <strong>XL Base model</strong> (Parameters tab) for Extract Mode — it preserves the most structural detail. '
    'XL Turbo at 0.98 denoise tends to over-generate and lose the reference. SFT is also good at 30–50 steps.</p>'
    "</body></html>"
)


_QUALITY_HTML = (
    f"<html><head>{_STYLE}</head><body>"
    '<h2 style="color:#7c65d9;border-left:4px solid #7c65d9;padding-left:8px;margin-bottom:16px">📊 Generation Quality Score</h2>'

    '<h3>What It Measures</h3>'
    '<p>Click 📊 Score on any job card to get a 0–10 composite quality score with per-dimension breakdowns and a letter grade (A/B/C/D).</p>'
    '<table>'
    '<tr><th>Dimension</th><th>Weight</th><th>Method</th><th>What It Catches</th></tr>'
    '<tr><td><strong>Loudness</strong></td><td>25%</td><td>pyloudnorm ITU-R BS.1770-4 LUFS vs –14 target</td><td>Too quiet, too loud, off streaming target</td></tr>'
    '<tr><td><strong>Dynamics</strong></td><td>20%</td><td>LRA approximation: 95th–10th percentile of active RMS</td><td>Over-compressed / brickwalled; lifeless dynamics</td></tr>'
    '<tr><td><strong>Spectral</strong></td><td>25%</td><td>STFT band energy ratios lo/mid/hi + centroid range check</td><td>Bass-heavy mud; tinny treble; missing mids</td></tr>'
    '<tr><td><strong>Saturation</strong></td><td>15%</td><td>Peak level + clipped sample count (samples > 0.999)</td><td>Digital clipping / distortion artifacts</td></tr>'
    '<tr><td><strong>Coherence</strong></td><td>15%</td><td>RMS coefficient of variation + silence percentage</td><td>Abrupt dropouts; inconsistent energy; excessive silence</td></tr>'
    '</table>'

    '<h3>Grade Scale</h3>'
    '<table>'
    '<tr><th>Grade</th><th>Score</th><th>Meaning</th></tr>'
    '<tr><td style="color:#4caf50"><strong>A</strong></td><td>≥ 8.0</td><td>Excellent — streaming-ready, well-balanced audio</td></tr>'
    '<tr><td style="color:#8bc34a"><strong>B</strong></td><td>≥ 6.5</td><td>Good — minor issues but usable for most purposes</td></tr>'
    '<tr><td style="color:#ff9800"><strong>C</strong></td><td>≥ 5.0</td><td>Acceptable — one or more dimensions need attention</td></tr>'
    '<tr><td style="color:#f44336"><strong>D</strong></td><td>&lt; 5.0</td><td>Poor — retake or adjust generation parameters</td></tr>'
    '</table>'

    '<h3>How To Improve Scores</h3>'
    '<ul>'
    '<li><strong>Low Loudness</strong> — Nyx-Step outputs are typically –14 to –18 LUFS; if scoring low, check if your tags include '
    '<code>quiet, ambient, whispered</code> — these intentionally reduce loudness. No intervention needed for streaming.</li>'
    '<li><strong>Low Dynamics</strong> — try raising CFG slightly (3–4) or switching sampler to euler_ancestral for more variation</li>'
    '<li><strong>Low Spectral</strong> — bass-heavy: add <code>bright, crisp, airy</code> tags or reduce bass instrument tags; '
    'treble-heavy: add <code>warm, full, deep bass</code></li>'
    '<li><strong>Low Saturation</strong> — clipping is rare in Nyx-Step outputs; if present, regenerate or reduce output volume before download</li>'
    '<li><strong>Low Coherence</strong> — high CV means energy spikes/dropouts; try increasing Steps or switching to er_sde + linear_quadratic</li>'
    '</ul>'

    '<h3>Limitations</h3>'
    '<p>The score is based on signal analysis of the output audio — it measures acoustic properties, not musical quality. '
    'A perfectly scored track might sound boring; an adventurous track might score lower on dynamics. '
    'Use the score as a sanity check for obvious problems, not as a creative filter.</p>'
    "</body></html>"
)


_LRC_HTML = (
    f"<html><head>{_STYLE}</head><body>"
    '<h2 style="color:#7c65d9;border-left:4px solid #7c65d9;padding-left:8px;margin-bottom:16px">🎵 LRC Synchronized Lyrics</h2>'

    '<h3>What It Does</h3>'
    '<p>Click 🎵 LRC on any job card (only shown when lyrics were provided at generation time) to generate a time-synchronized <code>.lrc</code> file. '
    'LRC files are the standard format used by most music players (Poweramp, Musicolet, foobar2000, VLC, etc.) to display lyrics '
    'scrolling in sync with the audio.</p>'

    '<h3>How Timing Is Generated</h3>'
    '<p>Since Nyx-Step doesn\'t expose its internal attention alignment, timing is approximated via audio signal analysis:</p>'
    '<ol>'
    '<li>Load audio and compute RMS energy envelope at ~43 Hz resolution</li>'
    '<li>Detect silence→active transitions where silence gaps are ≥ 0.8 s (phrase boundaries)</li>'
    '<li>If fewer boundaries than lyric lines: subdivide based on BPM (default 4 beats per line)</li>'
    '<li>Map each lyric line to the nearest detected or estimated phrase start time</li>'
    '<li>Output standard LRC format: <code>[MM:SS.cc]Lyric line</code></li>'
    '</ol>'

    '<h3>LRC File Format</h3>'
    '<pre>[ti:Generated by Nyx-Step]\n[ar:Nyx Studios]\n[length:03:24.00]\n[00:00.00]First lyric line\n[00:14.32]Second lyric line\n[00:28.17]Chorus begins here</pre>'

    '<h3>Tips</h3>'
    '<ul>'
    '<li>Accuracy improves when lyrics have clear phrase-boundary silences in the audio — instrumental intros/bridges help anchor the timing</li>'
    '<li>Section markers like <code>[Verse]</code>, <code>[Chorus]</code> in your lyrics are stripped from LRC output (they don\'t display in players) but don\'t interfere with timing detection</li>'
    '<li>Set the correct <strong>BPM</strong> before generating — this controls subdivision when silence-boundary detection doesn\'t find enough boundaries</li>'
    '<li>The .lrc file is saved alongside the audio in the ComfyUI output dir (same name, .lrc extension) and downloaded immediately</li>'
    '<li>For more accurate sync, import the LRC into your DAW and manually adjust timing against the waveform — the detection gives you a usable starting point, not frame-accurate alignment</li>'
    '</ul>'

    '<h3>Player Compatibility</h3>'
    '<table>'
    '<tr><th>Player</th><th>LRC Support</th></tr>'
    '<tr><td>Poweramp (Android)</td><td>Native — auto-detects .lrc in same folder</td></tr>'
    '<tr><td>Musicolet (Android)</td><td>Native — same-folder detection</td></tr>'
    '<tr><td>foobar2000</td><td>Via foo_uie_lyrics or ESLyric plugin</td></tr>'
    '<tr><td>VLC</td><td>Load via Media &gt; Subtitle File</td></tr>'
    '<tr><td>AIMP</td><td>Native LRC support</td></tr>'
    '<tr><td>Clementine / Strawberry</td><td>Native in Lyrics panel</td></tr>'
    '</table>'
    "</body></html>"
)


_LM_HTML = (
    f"<html><head>{_STYLE}</head><body>"
    '<h2 style="color:#7c65d9;border-left:4px solid #7c65d9;padding-left:8px;margin-bottom:16px">LM Stage &amp; Audio Codes</h2>'

    '<h3>What Is the LM Stage?</h3>'
    '<p>Nyx-Step generation runs two model passes back to back:</p>'
    '<ol>'
    '<li><strong>LM Stage</strong> — the Qwen language model reads your tags and lyrics and generates a sequence of discrete '
    '<em>audio code tokens</em> at ~5 Hz (one code per 0.2 s of audio). For a 30-second track this produces ~150 tokens; '
    'for 60 seconds, ~300. These codes are a low-resolution "semantic blueprint" of the sound over time — '
    'not audible audio, just numbers that describe what should happen when.</li>'
    '<li><strong>Diffusion Stage</strong> — the DiT (diffusion transformer) denoises random noise into a full waveform, '
    'conditioned on both your text tags <em>and</em> the audio codes from step 1. '
    'The codes act as an additional timeline roadmap for the diffusion process.</li>'
    '</ol>'
    '<p>No sound plays during the LM stage. You hear nothing until the diffusion stage completes and the full audio is ready.</p>'

    '<h3>What Does It Actually Improve?</h3>'
    '<ul>'
    '<li><strong>Structural coherence</strong> — verse/chorus transitions, drops, and instrumental sections tend to stay '
    'organised through the full duration. Without the codes, the diffusion model can wander harmonically in longer generations.</li>'
    '<li><strong>Lyric timing</strong> — the Qwen model has read your lyrics and encoded phrase boundaries into the codes, '
    'so sung words land more consistently at the right moments relative to the music structure.</li>'
    '<li><strong>Tonal consistency</strong> — the code sequence "locks in" a harmonic direction early, reducing the chance '
    'of unexpected key shifts or tonal drift mid-track.</li>'
    '</ul>'
    '<p>The tradeoff is time: the Qwen LM runs before diffusion starts, adding <strong>~10–30 s of overhead</strong> '
    'regardless of your steps setting. The diffusion step count does not affect LM speed.</p>'

    '<h3>No Carry Sound or Preview Audio</h3>'
    '<p>The LM stage is a silent backend computation. There is no audio output from the Qwen model — '
    'it outputs integer token IDs, not waveforms. You will not hear anything until the diffusion stage finishes '
    'and the complete file is ready. The overhead is pure GPU compute time.</p>'

    '<h3>When to Turn It Off</h3>'
    '<table>'
    '<tr><th>Situation</th><th>Recommendation</th><th>Why</th></tr>'
    '<tr><td>Cover / Remix / Repaint / Extract</td><td>Off (forced automatically)</td>'
    '<td>A reference audio is already providing the timeline structure. Running the LM would generate competing codes that fight the reference.</td></tr>'
    '<tr><td>Radio streaming (Turbo model)</td><td>Off or On with caution</td>'
    '<td>Each radio segment takes ~8 diffusion steps (~10–15 s). Adding 10–30 s of LM overhead per segment defeats the point of fast chaining. '
    'Radio already uses the previous segment as a timbre reference, which provides continuity without LM codes.</td></tr>'
    '<tr><td>Short previews / rapid iteration</td><td>Off</td>'
    '<td>When testing tag changes at 8 steps and 15–20 s duration, the LM overhead is often longer than the diffusion itself.</td></tr>'
    '<tr><td>Final quality renders (SFT or Base model, 30–60 s)</td><td>On</td>'
    '<td>The structural benefit is most noticeable at longer durations. The overhead is proportionally small against a 30–50 step generation.</td></tr>'
    '<tr><td>Vocal tracks with detailed lyrics</td><td>On</td>'
    '<td>Lyric phrase boundaries are encoded into the audio codes — syllable timing and section structure improve meaningfully.</td></tr>'
    '</table>'

    '<h3>The Audio Codes Cache (NyxNodes)</h3>'
    '<p>NyxNodes includes two custom ComfyUI nodes for advanced use:</p>'
    '<ul>'
    '<li><strong>NyxSaveAudioCodes</strong> — after a generation, saves the Qwen LM output (the audio code sequence) to '
    '<code>cache/{name}.json</code>.</li>'
    '<li><strong>NyxLoadAudioCodes</strong> — on the next generation, reinjects those saved codes directly into the conditioning, '
    'skipping the Qwen LM pass entirely. The diffusion model uses the previously generated codes.</li>'
    '</ul>'
    '<p>This is called <em>Fast Variation mode</em>: you can change tags, BPM, or sampler settings and regenerate with '
    'exactly the same structural blueprint. Useful for iterating on sound while keeping the arrangement locked.</p>'

    '<h3>Sampling Parameters (Temperature, Top-P, Top-K, Min-P)</h3>'
    '<p>These controls in the Parameters tab affect <em>only the Qwen LM</em>, not the diffusion model:</p>'
    '<table>'
    '<tr><th>Parameter</th><th>Effect on Qwen LM</th><th>Default</th></tr>'
    '<tr><td>Temperature</td><td>Higher = more varied/creative code sequences; lower = more predictable/literal structure</td><td>0.85</td></tr>'
    '<tr><td>Top-P</td><td>Nucleus sampling threshold — limits tokens to those covering P% of probability mass</td><td>0.9</td></tr>'
    '<tr><td>Top-K</td><td>Hard cap on candidate tokens per step (0 = off)</td><td>0</td></tr>'
    '<tr><td>Min-P</td><td>Filters tokens below P × max-token probability (0 = off)</td><td>0.0</td></tr>'
    '</table>'
    '<p>The diffusion model is controlled by Steps, CFG Scale, and the Sampler/Scheduler settings instead.</p>'
    "</body></html>"
)


def _parse_chapter(section_id: str) -> str:
    """Extract one <h2 id="section_id">...</h2> section from Aceuser.html."""
    if section_id == "starthere":
        return _START_HERE_HTML
    if section_id == "flowcharts":
        return _FLOWCHARTS_HTML
    if section_id == "scale":
        return _SCALE_HTML
    if section_id == "midi":
        return _MIDI_HTML
    if section_id == "analyze":
        return _ANALYZE_HTML
    if section_id == "sampler":
        return _SAMPLER_HTML
    if section_id == "lm":
        return _LM_HTML
    if section_id == "presets":
        return _PRESETS_HTML
    if section_id == "radio":
        return _RADIO_HTML
    if section_id == "extract":
        return _EXTRACT_HTML
    if section_id == "quality":
        return _QUALITY_HTML
    if section_id == "lrc":
        return _LRC_HTML
    if not config.ACEUSER_HTML.exists():
        return "<p>Guide file not found.</p>"
    raw = config.ACEUSER_HTML.read_text(encoding="utf-8")
    chunks = re.split(r'(?=<h2\s)', raw)
    for chunk in chunks:
        m = re.search(r'<h2[^>]*id="([^"]+)"', chunk)
        if m and m.group(1) == section_id:
            return f"<html><head>{_STYLE}</head><body>{chunk}</body></html>"
    if section_id == "summary":
        return f"<html><head>{_STYLE}</head><body><p style='color:#8a8f9e'>No summary content found.</p></body></html>"
    return f"<p>Section '{section_id}' not found.</p>"


@router.get("/guide/{section_id}", response_class=HTMLResponse)
async def guide_section(section_id: str):
    if section_id not in _CHAPTER_IDS:
        return HTMLResponse("<p>Invalid section.</p>", status_code=404)
    return HTMLResponse(_parse_chapter(section_id))


@router.get("/meta/{filename}")
async def meta(filename: str, request: Request):
    user_email = get_user_email(request)
    if not tracker.user_owns_file(user_email, filename):
        return JSONResponse({"error": "File not found or access denied"}, status_code=404)

    import core.db as db
    job = db.get_job_by_filename(filename)
    if job:
        job.pop("user_email", None)
        return JSONResponse(job)

    return JSONResponse({"error": "Metadata not found"}, status_code=404)


def _tag_audio(file_path: Path, meta: dict | None) -> bytes | None:
    """Return file bytes with ID3/FLAC tags applied from meta. Returns None on failure."""
    if not meta:
        return None
    try:
        ext = file_path.suffix.lower()
        raw = file_path.read_bytes()
        buf = io.BytesIO(raw)
        title   = meta.get("song_name", "")
        caption = meta.get("caption", "")
        seed    = str(meta.get("seed", ""))
        comment = f"Tags: {caption}\nSeed: {seed}" if caption else f"Seed: {seed}"

        if ext == ".mp3":
            from mutagen.mp3 import MP3
            from mutagen.id3 import ID3, TIT2, TPE1, COMM, ID3NoHeaderError
            audio = MP3(buf)
            try:
                tags = audio.tags or ID3()
            except ID3NoHeaderError:
                tags = ID3()
            tags.add(TIT2(encoding=3, text=title))
            tags.add(TPE1(encoding=3, text="Nyx-Step AI"))
            tags.add(COMM(encoding=3, lang="eng", desc="", text=comment))
            out = io.BytesIO()
            tags.save(out)
            # Prepend ID3 header to raw MP3 data (tags go at start)
            out.seek(0)
            return out.read() + raw

        elif ext in (".flac",):
            from mutagen.flac import FLAC
            audio = FLAC(buf)
            audio["title"]   = title
            audio["artist"]  = "Nyx-Step AI"
            audio["comment"] = comment
            out = io.BytesIO()
            audio.save(out)
            out.seek(0)
            return out.read()

    except Exception:
        pass
    return None


def _get_meta_for_file(filename: str) -> dict | None:
    """Look up job metadata for a filename from DB."""
    import core.db as db
    return db.get_job_by_filename(filename)


@router.get("/download/{filename:path}")
async def download(filename: str, request: Request):
    user_email = get_user_email(request)

    if not tracker.user_owns_file(user_email, filename):
        return JSONResponse({"error": "File not found or access denied"}, status_code=404)

    file_path = config.COMFYUI_OUTPUT_DIR / filename
    if not file_path.exists():
        return JSONResponse({"error": "File not on disk"}, status_code=404)

    ext = file_path.suffix.lower()
    media_type = {"mp3": "audio/mpeg", "flac": "audio/flac", "opus": "audio/ogg"}.get(ext.lstrip("."), "audio/mpeg")

    # Try to serve with embedded metadata tags
    meta = _get_meta_for_file(filename)
    tagged = _tag_audio(file_path, meta)
    if tagged:
        return StreamingResponse(
            io.BytesIO(tagged),
            media_type=media_type,
            headers={
                "Content-Disposition": f'attachment; filename="{filename}"',
                "Cache-Control": "no-store, no-cache, must-revalidate",
                "Pragma": "no-cache",
            },
        )

    return FileResponse(
        path=str(file_path),
        media_type=media_type,
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-store, no-cache, must-revalidate",
            "Pragma": "no-cache",
        },
    )


class _ZipRequest(BaseModel):
    filenames: list[str]
    zip_name: str = "nyx-step_batch.zip"


@router.post("/download/zip")
async def download_zip(req: _ZipRequest, request: Request):
    user_email = get_user_email(request)
    if not req.filenames:
        return JSONResponse({"error": "No filenames provided"}, status_code=400)
    if len(req.filenames) > 50:
        return JSONResponse({"error": "Max 50 files per ZIP"}, status_code=400)

    buf = io.BytesIO()
    added = 0
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for fname in req.filenames:
            if not tracker.user_owns_file(user_email, fname):
                continue
            fpath = config.COMFYUI_OUTPUT_DIR / fname
            if fpath.exists():
                zf.write(fpath, fname)
                added += 1

    if added == 0:
        return JSONResponse({"error": "No accessible files found"}, status_code=404)

    buf.seek(0)
    safe_name = re.sub(r"[^\w.\-]", "_", req.zip_name)
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{safe_name}"'},
    )
