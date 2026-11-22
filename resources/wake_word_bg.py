"""
KnockDesk Wake Word Detector — Background Process
Listens for the wake word (default voice model) and emits JSON events to stdout.
Spawned by Electron main.js as a child process.
"""

import sys
import json

# ── Dependency Guard ─────────────────────────────────────────────────────────
# If speech_recognition or pyaudio is missing, emit a clean error and exit
# instead of crashing silently.
try:
    import speech_recognition as sr
except ImportError:
    print(json.dumps({
        "type": "ERROR",
        "msg": "DEPENDENCY_MISSING: 'speech_recognition' is not installed. Run: pip install SpeechRecognition"
    }))
    sys.stdout.flush()
    sys.exit(1)

# PyAudio is required internally by speech_recognition for Microphone
try:
    import pyaudio  # noqa: F401
except ImportError:
    print(json.dumps({
        "type": "ERROR",
        "msg": "DEPENDENCY_MISSING: 'pyaudio' is not installed. Run: pip install pyaudio"
    }))
    sys.stdout.flush()
    sys.exit(1)


# ── Fuzzy Wake Word Matching ─────────────────────────────────────────────────
# Google Speech API sometimes mis-hears the wake word as similar words.
# We check if any word in the transcription is phonetically close.
WAKE_WORD_VARIANTS = {
    "knockdesk", "knock", "knockdeck", "knockdisk", "nockdesk",
    "knockdeskai", "knockdes", "knockdesck", "notdesk",
}

# Primary check: exact variant, or phrase containing knock+desk.
def is_wake_word(word: str) -> bool:
    w = word.lower().strip()
    if w in WAKE_WORD_VARIANTS:
        return True
    if "knock" in w and "desk" in w:
        return True
    return False


def find_trigger_word(words: list) -> str | None:
    """Find the trigger word from a list of words. Returns the word or None."""
    for word in words:
        if is_wake_word(word):
            return word
    return None


def listen_for_wake_word():
    r = sr.Recognizer()
    r.energy_threshold = 300
    r.dynamic_energy_threshold = True

    try:
        with sr.Microphone() as source:
            print(json.dumps({"type": "INFO", "msg": "Microphone initialized. Tuning ambient noise..."}))
            sys.stdout.flush()

            r.adjust_for_ambient_noise(source, duration=0.5)

            print(json.dumps({"type": "INFO", "msg": "KnockDesk Engine Active. Listening in background..."}))
            sys.stdout.flush()

            while True:
                try:
                    audio = r.listen(source, phrase_time_limit=10)

                    text = r.recognize_google(audio).lower()
                    words = text.split()
                    trigger_word = find_trigger_word(words)

                    if trigger_word:
                        # Extract the command (everything after the trigger word)
                        command = text.replace(trigger_word, "", 1).strip()
                        result = {
                            "type": "WAKE_WORD",
                            "text": text,
                            "command": command
                        }
                        print(json.dumps(result))
                        sys.stdout.flush()

                except sr.UnknownValueError:
                    # No speech detected — this is normal, just continue listening
                    pass
                except sr.RequestError:
                    print(json.dumps({"type": "ERROR", "msg": "Google Speech API Connection Issue"}))
                    sys.stdout.flush()
                except Exception as e:
                    print(json.dumps({"type": "ERROR", "msg": str(e)}))
                    sys.stdout.flush()

    except OSError as e:
        # Microphone not found or audio device error
        print(json.dumps({
            "type": "ERROR",
            "msg": f"MICROPHONE_ERROR: {str(e)}. Make sure a microphone is connected."
        }))
        sys.stdout.flush()
        sys.exit(1)


if __name__ == "__main__":
    try:
        listen_for_wake_word()
    except KeyboardInterrupt:
        sys.exit(0)
