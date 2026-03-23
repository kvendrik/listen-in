#!/usr/bin/env python3
"""Exit 0 if the model loads with the same WhisperModel class whisper-live uses."""
import sys

import torch

# Not `faster_whisper.WhisperModel` — whisper-live vendors a fork under transcriber/.
from whisper_live.transcriber.transcriber_faster_whisper import WhisperModel


def main() -> None:
    if len(sys.argv) != 2:
        print("usage: verify_whisper_model.py <model_id>", file=sys.stderr)
        sys.exit(2)
    model = sys.argv[1]
    device = "cuda" if torch.cuda.is_available() else "cpu"
    compute_type = "float16" if device == "cuda" else "int8"
    WhisperModel(
        model,
        device=device,
        compute_type=compute_type,
        local_files_only=False,
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(e, file=sys.stderr)
        sys.exit(1)
