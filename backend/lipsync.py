"""
Phoneme-based lipsync timeline generator.

Given a French text + ElevenLabs character-level timings, produce a
time-ordered list of viseme events that the browser plays in sync with
the audio playback.

Pipeline:
  1. Split text into words + track character index ranges
  2. Phonemize each word via espeak-ng (IPA output)
  3. Distribute phonemes across the character span using their original timings
  4. Map each phoneme → viseme (Aa, Ih, Ou, Ee, Oh, PP, FF, TH, Neutral)
  5. Emit timeline events: [(time, viseme, weight, jaw_open)]
"""
from __future__ import annotations

import re
from dataclasses import dataclass, asdict
from typing import List, Tuple

try:
    from phonemizer.backend import EspeakBackend
    _BACKEND = EspeakBackend(language='fr-fr', with_stress=False, preserve_punctuation=False)
except Exception as e:
    _BACKEND = None
    _INIT_ERR = e


# ────────────────────────────────────────────────────────────
# IPA → Viseme mapping (French-oriented)
# ────────────────────────────────────────────────────────────
# Viseme classes:
#   Aa — open vowel (mouth wide)       /a/ /ɑ/ /ɑ̃/
#   Ih — front vowel (mouth stretched) /i/ /e/ /ɛ/ /ɛ̃/ /j/
#   Ee — smile vowel                   /e/ /ɛ/  (subset of Ih with more smile)
#   Ou — rounded back vowel            /u/ /o/ /ɔ/ /ɔ̃/ /w/
#   Oh — mid open rounded              /ø/ /œ/ /œ̃/
#   PP — lips closed (bilabials)       /p/ /b/ /m/
#   FF — lip bite (labiodentals)       /f/ /v/
#   TH — tongue visible                /ð/ /θ/ (rare in fr)
#   DD — alveolar (tongue behind teeth) /t/ /d/ /n/ /l/ /s/ /z/
#   KK — back consonant                /k/ /g/ /ʁ/ /ʃ/ /ʒ/
#   Neutral — silence / rest
#
# Weights below are the blendshape target values (0..1) + jaw_open (0..1)
# jaw_open is applied to the jaw bone rotation.
VisemeSpec = Tuple[str, float, float]  # (viseme_name, weight, jaw_open)

IPA_TO_VISEME: dict[str, VisemeSpec] = {
    # Open vowels
    'a': ('Aa', 0.85, 0.55),
    'ɑ': ('Aa', 0.90, 0.60),
    'ɑ̃': ('Aa', 0.80, 0.50),
    'ã': ('Aa', 0.80, 0.50),
    # Front vowels (smile)
    'i': ('Ih', 0.75, 0.15),
    'e': ('Ee', 0.70, 0.20),
    'ɛ': ('Ee', 0.80, 0.30),
    'ɛ̃': ('Ee', 0.75, 0.28),
    'ẽ': ('Ee', 0.75, 0.28),
    'y': ('Ih', 0.65, 0.15),
    'j': ('Ih', 0.55, 0.10),
    # Rounded back
    'u': ('Ou', 0.85, 0.25),
    'o': ('Ou', 0.70, 0.30),
    'ɔ': ('Ou', 0.80, 0.40),
    'ɔ̃': ('Ou', 0.75, 0.35),
    'õ': ('Ou', 0.75, 0.35),
    'w': ('Ou', 0.70, 0.20),
    # Mid-front rounded
    'ø': ('Oh', 0.70, 0.25),
    'œ': ('Oh', 0.80, 0.35),
    'œ̃': ('Oh', 0.75, 0.30),
    'ə': ('Oh', 0.55, 0.20),
    'ɥ': ('Oh', 0.60, 0.20),
    # Bilabials — lips closed hard
    'p': ('PP', 1.0, 0.0),
    'b': ('PP', 1.0, 0.0),
    'm': ('PP', 1.0, 0.0),
    # Labiodentals — lip bite
    'f': ('FF', 0.9, 0.1),
    'v': ('FF', 0.9, 0.1),
    # Alveolars — tongue/teeth
    't': ('DD', 0.6, 0.15),
    'd': ('DD', 0.6, 0.15),
    'n': ('DD', 0.5, 0.10),
    'l': ('DD', 0.55, 0.15),
    's': ('DD', 0.5, 0.10),
    'z': ('DD', 0.5, 0.10),
    # Back / post-alveolar
    'k': ('KK', 0.5, 0.20),
    'g': ('KK', 0.5, 0.20),
    'ʁ': ('KK', 0.45, 0.25),
    'r': ('KK', 0.45, 0.25),
    'ʃ': ('KK', 0.55, 0.15),
    'ʒ': ('KK', 0.55, 0.15),
    'ɲ': ('DD', 0.5, 0.15),
    'ŋ': ('KK', 0.5, 0.15),
    'x': ('KK', 0.5, 0.15),
    'h': ('KK', 0.4, 0.15),
}


@dataclass
class VisemeEvent:
    t: float          # timestamp in seconds
    viseme: str       # one of Aa, Ih, Ee, Ou, Oh, PP, FF, DD, KK, Neutral
    weight: float     # 0..1 target blendshape weight
    jaw: float        # 0..1 jaw open amount

    def to_dict(self) -> dict:
        return {
            't': round(self.t, 4),
            'v': self.viseme,
            'w': round(self.weight, 3),
            'j': round(self.jaw, 3),
        }


def _tokenize_ipa(ipa: str) -> List[str]:
    """Split an IPA string into individual phoneme glyphs, keeping combining marks."""
    out: List[str] = []
    i = 0
    while i < len(ipa):
        ch = ipa[i]
        if ch.isspace() or ch in "'ˈˌ.,-":
            i += 1
            continue
        # Attach combining marks (nasals: U+0303)
        j = i + 1
        while j < len(ipa) and ipa[j] in '\u0303\u0361\u02D0':
            j += 1
        out.append(ipa[i:j])
        i = j
    return out


def _phonemize_word(word: str) -> List[str]:
    if _BACKEND is None:
        return []
    try:
        ipa = _BACKEND.phonemize([word], strip=True, njobs=1)[0]
        return _tokenize_ipa(ipa)
    except Exception:
        return []


def build_viseme_timeline(
    text: str,
    characters: List[str],
    start_times: List[float],
    end_times: List[float],
) -> List[dict]:
    """
    Build a viseme timeline from character-level timings returned by ElevenLabs.

    We walk through the characters, group them by word (whitespace-delimited),
    phonemize each word, and distribute the phoneme events uniformly across
    that word's character timespan. Between words, emit a Neutral rest event.
    """
    if not characters:
        return []

    events: List[VisemeEvent] = []

    # Ensure initial silence/neutral
    events.append(VisemeEvent(t=0.0, viseme='Neutral', weight=0.0, jaw=0.0))

    # Group character indices into words
    word_groups: List[Tuple[str, float, float]] = []  # (word_text, t_start, t_end)
    cur_chars: List[str] = []
    cur_start: float | None = None
    cur_end: float | None = None

    def flush():
        nonlocal cur_chars, cur_start, cur_end
        if cur_chars and cur_start is not None:
            word = ''.join(cur_chars)
            # Strip punctuation at edges for phonemization
            word_stripped = re.sub(r'[^\w\'\-àâäéèêëïîôöùûüÿçœæ]', '', word, flags=re.IGNORECASE)
            if word_stripped:
                word_groups.append((word_stripped, cur_start, cur_end or cur_start))
        cur_chars = []
        cur_start = None
        cur_end = None

    for i, ch in enumerate(characters):
        if ch.isspace() or ch in ',.!?;:"()[]':
            # Close current word then emit a short rest
            if cur_chars:
                flush()
        else:
            if not cur_chars:
                cur_start = start_times[i]
            cur_chars.append(ch)
            cur_end = end_times[i]
    flush()

    # Distribute phonemes across each word's timespan
    for word, t0, t1 in word_groups:
        phonemes = _phonemize_word(word)
        if not phonemes:
            continue
        duration = max(0.03, t1 - t0)
        step = duration / len(phonemes)
        # Small lead-time: phonemes start ~30ms before audio for natural anticipation
        LEAD = 0.03
        for k, ph in enumerate(phonemes):
            t = t0 + k * step - LEAD
            spec = IPA_TO_VISEME.get(ph)
            if spec is None:
                # Try stripping combining marks
                base = ph[0] if ph else ''
                spec = IPA_TO_VISEME.get(base)
            if spec is None:
                continue
            viseme, weight, jaw = spec
            events.append(VisemeEvent(t=max(0.0, t), viseme=viseme, weight=weight, jaw=jaw))
        # Short decay after the word
        events.append(VisemeEvent(t=t1, viseme='Neutral', weight=0.0, jaw=0.05))

    # Final rest
    if end_times:
        events.append(VisemeEvent(t=end_times[-1] + 0.05, viseme='Neutral', weight=0.0, jaw=0.0))

    # Sort & dedupe consecutive identical events
    events.sort(key=lambda e: e.t)
    return [e.to_dict() for e in events]
