import serial, time, sys
ser = serial.Serial()
ser.port = "COM5"; ser.baudrate = 115200
ser.dtr = False; ser.rts = False; ser.timeout = 0.3
ser.open()
time.sleep(0.4)
ser.rts = True; time.sleep(0.2); ser.rts = False
t0 = time.time()
try:
    while time.time() - t0 < 12:
        try:
            data = ser.read(8192)
        except Exception:
            continue
        if data:
            sys.stdout.write(data.decode("utf-8", "replace")); sys.stdout.flush()
finally:
    try: ser.close()
    except Exception: pass
print("\n<<CAPTURE_DONE>>")
