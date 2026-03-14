import os
import sys
import time
import json
import socket
import threading
import numpy as np
import sounddevice as sd
from scipy import signal
from typing import Optional, Tuple, Any

# Audio Configuration
SAMPLE_RATE = 48000
CHANNELS = 1
BLOCK_SIZE = 480  # 10ms at 48k
DTYPE = 'int16'

class AudioEngine:
    def __init__(self):
        self.muted: bool = False
        self.running: bool = False
        self.udp_socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.target_address: Optional[Tuple[str, int]] = None
        self.stream_obj: Any = None
        
        # VAD & AGC Parameters
        self.vad_threshold: float = 800.0  # Less sensitive to filter noise
        self.vad_silence_limit: int = 25  # ~250ms
        self.silence_counter: int = 0
        self.is_speaking: bool = False
        
        self.target_energy: float = 6000.0 # Higher target for better presence
        self.gain: float = 1.0
        self.max_gain: float = 6.0 # Lower max gain to avoid noise amplification
        
        # Filter State (Butterworth High-Pass 100Hz)
        # Removes low frequency rumble/hum below 100Hz
        sos = signal.butter(4, 100, 'hp', fs=SAMPLE_RATE, output='sos')
        self.filter_sos = sos
        self.filter_state = np.zeros((sos.shape[0], 2))
        
    def log(self, type_str: str, message: str):
        print(json.dumps({"type": type_str, "message": message}), flush=True)

    def start(self, host: str, port: int):
        self.target_address = (str(host), int(port))
        self.log("info", f"Target set to {host}:{port}")
        
        if self.running:
            return

        self.running = True
        try:
            self.stream_obj = sd.InputStream(
                samplerate=SAMPLE_RATE,
                channels=CHANNELS,
                dtype=DTYPE,
                blocksize=BLOCK_SIZE,
                callback=self._audio_callback
            )
            self.stream_obj.start()
            self.log("status", "Audio engine started with HPF")
        except Exception as e:
            self.running = False
            self.log("error", f"Stream start failed: {str(e)}")

    def stop(self):
        self.running = False
        if self.stream_obj:
            try:
                self.stream_obj.stop()
                self.stream_obj.close()
            except Exception:
                pass
            self.stream_obj = None
        self.log("status", "Audio engine stopped")

    def set_mute(self, muted: bool):
        self.muted = muted
        self.log("info", f"Mute set to {muted}")

    def _audio_callback(self, indata, frames, time_info, status):
        if status:
            self.log("warning", str(status))
        
        if self.muted or not self.running:
            return

        # 1. Input conversion
        samples = indata.flatten().astype(np.float32)
        
        # 2. High-Pass Filter (100Hz) - Removes rumble
        samples, self.filter_state = signal.sosfilt(self.filter_sos, samples, zi=self.filter_state)
        
        # 3. VAD Logic (RMS based)
        energy = np.sqrt(np.mean(samples**2))
        
        if energy > self.vad_threshold:
            self.silence_counter = 0
            if not self.is_speaking:
                self.is_speaking = True
                self.log("vad", "speaking")
        else:
            self.silence_counter += 1
            if self.silence_counter > self.vad_silence_limit:
                if self.is_speaking:
                    self.is_speaking = False
                    self.log("vad", "silent")
                return # Skip transmission
        
        # 4. AGC Logic
        if energy > 20: 
            current_target_gain = self.target_energy / max(energy, 1.0)
            # Smoothing (0.1) for slightly faster but still smooth reaction
            self.gain = (self.gain * 0.9) + (min(float(current_target_gain), self.max_gain) * 0.1)
        
        # 5. Apply Gain & Peak Limiter/Prevent Clipping
        processed = samples * self.gain
        
        # Simple Soft Limiter: if sample > 30000, start squashing it
        # This prevents harsh digital clipping
        limit = 32000
        processed = np.clip(processed, -limit, limit)
        
        processed_data = processed.astype(np.int16).tobytes()
        
        # 6. UDP Transmission
        if self.target_address:
            try:
                self.udp_socket.sendto(processed_data, self.target_address)
            except Exception as e:
                self.log("error", f"UDP Send Error: {str(e)}")

    def listen_commands(self):
        while True:
            try:
                line = sys.stdin.readline()
                if not line:
                    break
                cmd = json.loads(line)
                action = cmd.get("action")
                
                if action == "start":
                    h = cmd.get("host")
                    p = cmd.get("port")
                    if h and p:
                        self.start(h, p)
                elif action == "stop":
                    self.stop()
                elif action == "mute":
                    self.set_mute(cmd.get("value"))
                elif action == "exit":
                    self.stop()
                    sys.exit(0)
            except Exception as e:
                self.log("error", f"Command Error: {str(e)}")

if __name__ == "__main__":
    engine = AudioEngine()
    engine.log("status", "Engine initialized v1.0.5")
    engine.listen_commands()
