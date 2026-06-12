"""Generate the built-in golden preset pack. Run from the repo root:
    python3 scripts/make_golden_presets.py
"""
import json
import pathlib

OUT = pathlib.Path(__file__).resolve().parent.parent / "presets_builtin"
OUT.mkdir(exist_ok=True)

BASE = {
    "_version": 1, "lyrics": "", "mode": "", "chords": "", "notes": "",
    "seed": 0, "lock_seed": False, "temperature": 0.85, "top_p": 0.9,
    "top_k": 0, "min_p": 0.0, "audio_format": "mp3", "audio_quality": "V0",
    "vocal_language": "auto", "generate_audio_codes": True, "batch_size": 1,
    "lora_name": "", "lora_scale": 1.0, "lora2_name": "", "lora2_scale": 1.0,
    "sampler_name": "er_sde", "scheduler": "linear_quadratic",
}

# name, tags, genre, bpm, key, scale, time_sig, instruments, vocal_tags, steps, cfg, duration, dit
PRESETS = [
    ("Golden - Lo-Fi Study",
     "lo-fi hip hop, chillhop, vinyl warmth, mellow, jazzy chords, dusty drums, relaxed, late night",
     "Lo-Fi Hip Hop", 82, "D", "Minor", "4/4",
     ["electric piano", "vinyl crackle", "soft drums", "upright bass"], [],
     8, 2.0, 90, "turbo"),
    ("Golden - Synthwave Drive",
     "synthwave, retrowave, 80s, analog synth, neon, driving, nostalgic, gated reverb drums",
     "Synthwave", 105, "A", "Minor", "4/4",
     ["analog synthesizer", "drum machine", "synth bass", "arpeggiator"], [],
     8, 2.0, 120, "turbo"),
    ("Golden - Epic Cinematic",
     "epic orchestral, cinematic, film score, powerful, dramatic, sweeping strings, taiko drums",
     "Cinematic", 95, "D", "Minor", "4/4",
     ["strings", "brass", "taiko drums", "choir", "french horn"], ["choir", "ethereal"],
     30, 7.0, 120, "sft"),
    ("Golden - Jazz Trio Night",
     "jazz trio, late night, smoky club, swing, brushed drums, walking bass, sophisticated",
     "Jazz", 110, "Bb", "Major", "4/4",
     ["piano", "upright bass", "brushed drums"], [],
     30, 7.0, 120, "sft"),
    ("Golden - Festival EDM",
     "edm, big room house, festival, energetic, euphoric, sidechain pump, massive drop",
     "EDM", 128, "F", "Minor", "4/4",
     ["supersaw synth", "kick drum", "synth bass", "white noise riser"], ["female vocal", "powerful"],
     8, 2.0, 120, "turbo"),
    ("Golden - Acoustic Folk",
     "acoustic folk, intimate, warm, fingerpicked guitar, organic, campfire, heartfelt",
     "Folk", 92, "G", "Major", "4/4",
     ["acoustic guitar", "upright bass", "light percussion", "harmonica"], ["male vocal", "warm", "intimate"],
     30, 7.0, 150, "sft"),
    ("Golden - Heavy Metal",
     "heavy metal, aggressive, distorted guitar, double kick, powerful, dark, driving riffs",
     "Metal", 145, "E", "Minor", "4/4",
     ["distorted guitar", "bass guitar", "double kick drums"], ["male vocal", "powerful", "gritty texture"],
     8, 2.5, 150, "turbo"),
    ("Golden - Deep House",
     "deep house, groovy, warm bassline, smooth, four on the floor, soulful, club",
     "House", 122, "A", "Minor", "4/4",
     ["synth bass", "drum machine", "electric piano", "pad"], ["female vocal", "soulful", "smooth"],
     8, 2.0, 180, "turbo"),
    ("Golden - Classical Piano",
     "solo piano, classical, romantic era, expressive, rubato, emotional, concert hall",
     "Classical", 72, "C", "Minor", "3/4",
     ["grand piano"], [],
     50, 7.0, 120, "sft"),
    ("Golden - Reggae Roots",
     "reggae, roots, laid back, skank guitar, dub bass, island, sunny, organ bubble",
     "Reggae", 75, "G", "Major", "4/4",
     ["electric guitar", "bass guitar", "organ", "drums"], ["male vocal", "relaxed"],
     8, 2.0, 150, "turbo"),
    ("Golden - Trap Banger",
     "trap, hard hitting, 808 bass, hi-hat rolls, dark, modern, bouncy",
     "Trap", 140, "F#", "Minor", "4/4",
     ["808 bass", "drum machine", "synthesizer", "bell lead"], ["male vocal", "rap", "confident"],
     8, 2.0, 120, "turbo"),
    ("Golden - Ambient Drift",
     "ambient, atmospheric, ethereal, slow evolving pads, spacious, meditative, no drums",
     "Ambient", 60, "C", "Major", "4/4",
     ["synth pad", "field recordings", "soft piano", "drone"], [],
     30, 5.0, 180, "sft"),
    ("Golden - Funk Groove",
     "funk, groovy, syncopated, slap bass, tight horns, wah guitar, party, 70s",
     "Funk", 108, "E", "Minor", "4/4",
     ["slap bass", "electric guitar", "horn section", "drums", "clavinet"], ["male vocal", "energetic"],
     8, 2.0, 150, "turbo"),
    ("Golden - Country Road",
     "country, americana, twangy guitar, heartland, storytelling, warm, steel guitar",
     "Country", 98, "D", "Major", "4/4",
     ["acoustic guitar", "pedal steel guitar", "bass", "drums", "fiddle"], ["male vocal", "warm"],
     30, 7.0, 165, "sft"),
    ("Golden - RnB Slow Jam",
     "r&b, slow jam, smooth, silky, late night, lush chords, modern soul",
     "R&B", 68, "Eb", "Major", "4/4",
     ["electric piano", "synth bass", "drum machine", "strings"], ["female vocal", "smooth", "breathy", "melismatic"],
     30, 7.0, 165, "sft"),
    ("Golden - Drum and Bass",
     "drum and bass, liquid dnb, rolling breaks, deep sub bass, atmospheric, fast, energetic",
     "Drum and Bass", 174, "A", "Minor", "4/4",
     ["breakbeat drums", "sub bass", "synth pad", "piano"], ["female vocal", "ethereal", "airy tone"],
     8, 2.0, 150, "turbo"),
]

for (name, tags, genre, bpm, key, scale, tsig, instruments, vocals,
     steps, cfg, duration, dit) in PRESETS:
    preset = dict(BASE)
    preset.update({
        "song_name": name, "tags": tags, "genre": genre, "bpm": bpm,
        "key": key, "scale": scale, "time_sig": tsig,
        "instruments": instruments, "vocal_tags": vocals,
        "steps": steps, "cfg_scale": cfg, "duration": duration,
        "dit_model": dit,
    })
    path = OUT / f"{name}.nyx"
    path.write_text(json.dumps(preset, indent=2), encoding="utf-8")
    print("wrote", path.name)
