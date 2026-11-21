"""Print Stack-chan's serial log, without the camera driver's frame-drop noise.

The camera driver prints "cam_hal: EV-EOF-OVF" / "EV-VSYNC-OVF" from an
interrupt every time it drops a preview frame (several per second). It's
harmless, can't be turned off from the firmware, and buries everything else,
so it's filtered here.

    python firmware/stackchan-scale/tools/serial_log.py            # COM3, until Ctrl+C
    python firmware/stackchan-scale/tools/serial_log.py COM5 60    # port, seconds
    python firmware/stackchan-scale/tools/serial_log.py --all      # keep the noise

Needs pyserial (pip install pyserial). Opening the port may reset the device.
"""
import sys
import time

import serial

NOISE = ("cam_hal: EV-EOF-OVF", "cam_hal: EV-VSYNC-OVF")


def main(argv):
    keep_all = "--all" in argv
    args = [a for a in argv if a != "--all"]
    port = args[0] if args else "COM3"
    seconds = float(args[1]) if len(args) > 1 else None
    end = time.time() + seconds if seconds else None

    with serial.Serial(port, 115200, timeout=0.5) as s:
        while end is None or time.time() < end:
            line = s.readline().decode("utf-8", "replace").rstrip()
            if line and (keep_all or not line.startswith(NOISE)):
                print(line, flush=True)


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except KeyboardInterrupt:
        pass
