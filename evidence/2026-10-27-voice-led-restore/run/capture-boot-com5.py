import serial, time, sys
ser = serial.Serial()
ser.port = "COM5"; ser.baudrate = 115200
ser.dtr = False; ser.rts = False; ser.timeout = 0.2
ser.open()
time.sleep(0.5)
ser.rts = True; time.sleep(0.2); ser.rts = False
t0 = time.time()
while time.time() - t0 < 15:
    data = ser.read(8192)
    if data:
        sys.stdout.write(data.decode("utf-8", "replace")); sys.stdout.flush()
ser.close()
print("\n<<CAPTURE_DONE>>")
