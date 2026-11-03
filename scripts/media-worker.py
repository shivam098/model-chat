"""Bounded, offline media extraction. Only app-owned temporary input paths are accepted."""
import argparse
import base64
import importlib.metadata
import io
import json
import os
from pathlib import Path
import sys

MAX_FRAMES = 4
MAX_FRAME_BYTES = 512 * 1024
PROGRESS_ENABLED = True
FORMATS = {
    "wav": "wav", "mp3": "mp3", "m4a": "mov", "aac": "aac",
    "flac": "flac", "ogg": "ogg", "opus": "ogg",
    "mp4": "mov", "mov": "mov", "webm": "matroska", "mkv": "matroska", "avi": "avi",
}


class MediaError(Exception):
    pass


def probe(model):
    from faster_whisper.utils import download_model
    model_path = Path(model) if Path(model).is_dir() else Path(download_model(model, local_files_only=True))
    for required in ("model.bin", "config.json", "tokenizer.json"):
        if not (model_path / required).is_file():
            raise MediaError("The local Whisper model is incomplete. Run setup:media with a complete cached model.")
    return {
        "python": sys.executable,
        "modelPath": str(model_path.resolve()),
        "modelName": model if not Path(model).is_dir() else model_path.name,
        "versions": {name: importlib.metadata.version(name) for name in ("faster-whisper", "ctranslate2", "av", "numpy", "Pillow")},
    }


def verify_signature(data, extension):
    if extension == "wav":
        valid = data[:4] in (b"RIFF", b"RF64") and data[8:12] == b"WAVE"
    elif extension == "avi":
        valid = data[:4] == b"RIFF" and data[8:12] == b"AVI "
    elif extension in ("mp4", "m4a", "mov"):
        valid = data[4:8] in (b"ftyp", b"moov", b"mdat", b"free", b"wide")
    elif extension in ("webm", "mkv"):
        valid = data[:4] == b"\x1a\x45\xdf\xa3"
    elif extension in ("ogg", "opus"):
        valid = data[:4] == b"OggS"
    elif extension == "flac":
        valid = data[:4] == b"fLaC"
    elif extension in ("mp3", "aac"):
        valid = data[:3] == b"ID3" or (len(data) > 1 and data[0] == 255 and data[1] & 0xE0 == 0xE0)
    else:
        valid = False
    if not valid:
        raise MediaError("The media bytes do not match the file extension. Playlists and network references are not accepted.")


def open_media(file, extension):
    import av
    return av.open(str(file), mode="r", format=FORMATS[extension], options={
        "protocol_whitelist": "file",
        "enable_drefs": "0",
        "use_absolute_path": "0",
        "probesize": "1048576",
        "analyzeduration": "3000000",
    })


def clock(seconds):
    return f"{int(seconds // 60):02d}:{seconds % 60:06.3f}"


def progress(stage, seconds=0, duration=None):
    if PROGRESS_ENABLED:
        print(json.dumps({"event": "progress", "stage": stage, "seconds": seconds, "duration": duration}), flush=True)


def audio_chunks(file, extension):
    import av
    import numpy as np
    window_size = 30 * 16000
    overlap = 8000
    window = np.empty(window_size, dtype=np.float32)
    filled = 0
    offset = 0
    with open_media(file, extension) as container:
        if not container.streams.audio:
            return
        stream = container.streams.audio[0]
        stream.codec_context.thread_count = 2
        resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)
        def converted_frames():
            for frame in container.decode(stream):
                yield from resampler.resample(frame)
            yield from resampler.resample(None)
        for converted in converted_frames():
            values = converted.to_ndarray().reshape(-1).astype(np.float32) / 32768.0
            position = 0
            while position < len(values):
                take = min(window_size - filled, len(values) - position)
                window[filled:filled + take] = values[position:position + take]
                filled += take
                position += take
                if filled == window_size:
                    yield offset / 16000, window.copy()
                    window[:overlap] = window[-overlap:]
                    offset += window_size - overlap
                    filled = overlap
    if filled > overlap or (offset == 0 and filled):
        yield offset / 16000, window[:filled].copy()


def extract_frames(file, extension, duration):
    import av
    frames = []
    with open_media(file, extension) as container:
        streams = [stream for stream in container.streams.video if not int(stream.disposition) & 0x400]
        if not streams:
            return frames
        stream = streams[0]
        width, height = stream.codec_context.width, stream.codec_context.height
        if not width or not height or max(width, height) > 4096 or width * height > 16_000_000:
            raise MediaError("Video exceeds the supported 4096-pixel or 16-megapixel frame limits.")
        if duration is None or duration <= 0:
            raise MediaError("The video duration could not be determined. Re-export it as a standard MP4.")
        stream.codec_context.thread_count = 2
        targets = [max(0, duration - 0.1) * index / (MAX_FRAMES - 1) for index in range(MAX_FRAMES)]
        seen = set()
        for target in targets:
            container.seek(int(target / float(stream.time_base)), stream=stream, backward=True, any_frame=False)
            chosen = None
            for index, frame in enumerate(container.decode(stream)):
                if index % 100 == 0:
                    progress("sampling_frames", target, duration)
                chosen = frame
                if frame.time is None or frame.time >= target:
                    break
            if chosen is None:
                continue
            timestamp = max(0, float(chosen.time if chosen.time is not None else target))
            identity = chosen.pts if chosen.pts is not None else round(timestamp, 3)
            if identity in seen:
                continue
            seen.add(identity)
            image = chosen.to_image().convert("RGB")
            image.thumbnail((960, 540))
            output = io.BytesIO()
            image.save(output, format="JPEG", quality=80)
            data = output.getvalue()
            if len(data) > MAX_FRAME_BYTES:
                raise MediaError("A sampled video frame exceeds the safe size limit. Use a lower-resolution clip.")
            frames.append({"seconds": round(timestamp, 3), "mimeType": "image/jpeg", "data": base64.b64encode(data).decode("ascii")})
    if not frames:
        raise MediaError("No video frames could be decoded.")
    return frames


def process(file, model_path, model_name, output_directory):
    import av
    from faster_whisper import WhisperModel
    av.logging.set_level(av.logging.ERROR)
    extension = file.suffix.lower().lstrip(".")
    if extension not in FORMATS:
        raise MediaError("Unsupported audio/video format.")
    with file.open("rb") as source:
        verify_signature(source.read(32), extension)
    with open_media(file, extension) as container:
        duration = float(container.duration / av.time_base) if container.duration is not None else None
        has_video = any(not int(stream.disposition) & 0x400 for stream in container.streams.video)
        has_audio = bool(container.streams.audio)
        if not has_video and not has_audio:
            raise MediaError("No supported audio or video stream was found.")
    progress("sampling_frames" if has_video else "starting_transcription", 0, duration)
    frames = extract_frames(file, extension, duration) if has_video else []
    language = None
    model = None
    line_count = 0
    last_end = -1
    last_text = ""
    summary = f"[{'Video' if has_video else 'Audio'}: approximately {(duration or 0):.1f} seconds]"
    with (output_directory / "text.txt").open("w", encoding="utf-8") as output:
        output.write(summary + "\n[Local machine transcript; timestamps refer to the decoded audio timeline. Verify against the original.]\n")
        if has_audio:
            for offset, audio in audio_chunks(file, extension):
                progress("transcribing", offset, duration)
                if model is None:
                    model = WhisperModel(str(model_path), device="cpu", compute_type="int8", cpu_threads=4, num_workers=1, local_files_only=True)
                segments, info = model.transcribe(audio, beam_size=1, vad_filter=True, condition_on_previous_text=False)
                language = info.language
                for segment in segments:
                    text = segment.text.strip()
                    start, end = offset + segment.start, offset + segment.end
                    if text and end > last_end + 0.05 and not (text == last_text and start < last_end + 0.5):
                        output.write(f"[{clock(start)} - {clock(end)}] {text}\n")
                        line_count += 1
                        last_end, last_text = end, text
                output.flush()
                progress("transcribing", offset + len(audio) / 16000, duration)
        if not line_count:
            output.write("No speech detected in the audio track.\n" if has_audio else "No audio track.\n")
        if frames:
            output.write("[Visual sampling only: " + ", ".join(clock(frame["seconds"]) for frame in frames) + ". Unsampled motion/events are not available to the model.]\n")
    mime = ("video/" + ("webm" if extension == "webm" else "x-matroska" if extension == "mkv" else "x-msvideo" if extension == "avi" else "mp4")) if has_video else (
        "audio/mpeg" if extension == "mp3" else "audio/wav" if extension == "wav" else "audio/flac" if extension == "flac" else "audio/ogg" if extension in ("ogg", "opus") else "audio/aac" if extension == "aac" else "audio/webm" if extension == "webm" else "audio/x-matroska" if extension == "mkv" else "video/x-msvideo" if extension == "avi" else "audio/mp4"
    )
    return {
        "textFile": "text.txt",
        "notes": f"Processed locally with Whisper {model_name}; {language or 'no detected speech'}; approximately {(duration or 0):.1f}s; {len(frames)} sampled video frames. Transcription can be imperfect; this is not full-fidelity audio/motion understanding.",
        "mimeType": mime, "frames": frames,
    }


def main():
    global PROGRESS_ENABLED
    parser = argparse.ArgumentParser()
    parser.add_argument("--probe", action="store_true")
    parser.add_argument("--model", default="large-v3-turbo")
    parser.add_argument("--model-name", default="large-v3-turbo")
    parser.add_argument("--input")
    parser.add_argument("--output")
    args = parser.parse_args()
    os.environ["HF_HUB_OFFLINE"] = "1"
    if args.probe:
        result = probe(args.model)
    else:
        if not args.input or not Path(args.model).is_dir():
            raise MediaError("Local media processing is not configured. Run npm run setup:media.")
        if args.output:
            result = process(Path(args.input), Path(args.model), args.model_name, Path(args.output))
        else:
            # Compatibility for an already-running backend during a source update.
            import tempfile
            PROGRESS_ENABLED = False
            with tempfile.TemporaryDirectory(dir=Path(args.input).parent) as temporary:
                result = process(Path(args.input), Path(args.model), args.model_name, Path(temporary))
                result["text"] = (Path(temporary) / "text.txt").read_text(encoding="utf-8")
                del result["textFile"]
    print(json.dumps({"ok": True, **result}, ensure_ascii=True))


try:
    main()
except MediaError as error:
    print(json.dumps({"ok": False, "error": str(error)}))
    sys.exit(1)
except Exception as error:
    print(json.dumps({"ok": False, "error": "The local media processor could not decode or transcribe this file. Check setup or retry a standard encoding; the original is retained.", "kind": type(error).__name__}))
    sys.exit(1)
