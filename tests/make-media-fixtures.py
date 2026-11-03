import math
import sys
import wave
from fractions import Fraction
from pathlib import Path

import av
import numpy as np
from PIL import Image, ImageDraw

root = Path(sys.argv[1])
source = root / "speech.wav"
with av.open(str(source)) as audio:
    duration = audio.duration / av.time_base


def add_audio(destination, codec, stream=None):
    if stream is None:
        stream = destination.add_stream(codec, rate=16000)
        stream.layout = "mono"
    resampler = av.AudioResampler(format="fltp" if codec == "aac" else "s16p", layout="mono", rate=16000)
    position = 0
    with av.open(str(source)) as audio:
        for frame in audio.decode(audio=0):
            for normalized in resampler.resample(frame):
                normalized.pts = position
                normalized.time_base = Fraction(1, 16000)
                position += normalized.samples
                for packet in stream.encode(normalized):
                    destination.mux(packet)
    for normalized in resampler.resample(None):
        normalized.pts = position
        normalized.time_base = Fraction(1, 16000)
        position += normalized.samples
        for packet in stream.encode(normalized):
            destination.mux(packet)
    for packet in stream.encode():
        destination.mux(packet)


def movie(file, with_audio):
    with av.open(str(file), mode="w") as destination:
        video = destination.add_stream("mpeg4", rate=10)
        video.width = 320
        video.height = 180
        video.pix_fmt = "yuv420p"
        video.codec_context.gop_size = 10
        audio_stream = destination.add_stream("aac", rate=16000) if with_audio else None
        if audio_stream is not None:
            audio_stream.layout = "mono"
        for index in range(math.ceil(duration * 10)):
            image = Image.new("RGB", (320, 180), "red" if index < duration * 5 else "blue")
            ImageDraw.Draw(image).text((20, 20), f"Sample frame {index}", fill="white")
            frame = av.VideoFrame.from_image(image)
            frame.pts = index
            frame.time_base = Fraction(1, 10)
            for packet in video.encode(frame):
                destination.mux(packet)
        for packet in video.encode():
            destination.mux(packet)
        if with_audio:
            add_audio(destination, "aac", audio_stream)


print("Encoding MP3 fixture", flush=True)
with av.open(str(root / "speech.mp3"), mode="w") as output:
    add_audio(output, "libmp3lame")
print("Encoding spoken MP4 fixture", flush=True)
movie(root / "speech-video.mp4", True)
print("Encoding silent MP4 fixture", flush=True)
movie(root / "silent-video.mp4", False)
with wave.open(str(root / "long-speech.wav"), "wb") as output:
    output.setnchannels(2)
    output.setsampwidth(2)
    output.setframerate(48000)
    for _ in range(200):
        output.writeframes(b"\x00" * 48000 * 4)
    resampler = av.AudioResampler(format="s16", layout="stereo", rate=48000)
    with av.open(str(source)) as audio:
        for frame in audio.decode(audio=0):
            for converted in resampler.resample(frame):
                output.writeframes(converted.to_ndarray().astype(np.int16).tobytes())
    for converted in resampler.resample(None):
        output.writeframes(converted.to_ndarray().astype(np.int16).tobytes())
print("Synthetic WAV/MP3/MP4 and >25 MB, >3-minute speech-at-200s fixtures created.")
