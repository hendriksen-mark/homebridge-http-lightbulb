from http.server import BaseHTTPRequestHandler, HTTPServer
import json

STATE = {
    "on": False,
    "brightness": 100,
    "hue": 0,
    "saturation": 100,
    "colorTemperature": 140
}

class DummyLightbulbHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        path_parts = self.path.strip('/').split('/')
        if self.path == "/on":
            STATE["on"] = True
            print("Lightbulb turned on")
            self.send_response(200)
            self.send_header('Content-type', 'text/plain')
            self.end_headers()
            self.wfile.write(b'1' if STATE["on"] else b'0')
        elif self.path == "/off":
            STATE["on"] = False
            print("Lightbulb turned off")
            self.send_response(200)
            self.send_header('Content-type', 'text/plain')
            self.end_headers()
            self.wfile.write(b'0' if STATE["on"] else b'1')
        elif self.path == "/status":
            # Respond with '1' for ON, '0' for OFF (as expected by statusPattern)
            self.send_response(200)
            self.send_header('Content-type', 'text/plain')
            self.end_headers()
            self.wfile.write(b'1' if STATE["on"] else b'0')
        elif path_parts[0] == "brightness":
            if len(path_parts) > 1:
                try:
                    STATE["brightness"] = int(path_parts[1])
                    print(f"Brightness set to {STATE['brightness']}")
                except Exception:
                    pass
            self.send_response(200)
            self.send_header('Content-type', 'text/plain')
            self.end_headers()
            self.wfile.write(str(STATE["brightness"]).encode())
        elif path_parts[0] == "hue":
            if len(path_parts) > 1:
                try:
                    STATE["hue"] = int(path_parts[1])
                    print(f"Hue set to {STATE['hue']}")
                except Exception:
                    pass
            self.send_response(200)
            self.send_header('Content-type', 'text/plain')
            self.end_headers()
            self.wfile.write(str(STATE["hue"]).encode())
        elif path_parts[0] == "saturation":
            if len(path_parts) > 1:
                try:
                    STATE["saturation"] = int(path_parts[1])
                    print(f"Saturation set to {STATE['saturation']}")
                except Exception:
                    pass
            self.send_response(200)
            self.send_header('Content-type', 'text/plain')
            self.end_headers()
            self.wfile.write(str(STATE["saturation"]).encode())
        elif path_parts[0] == "colortemperature":
            if len(path_parts) > 1:
                try:
                    STATE["colorTemperature"] = int(path_parts[1])
                    print(f"Color Temperature set to {STATE['colorTemperature']}")
                except Exception:
                    pass
            self.send_response(200)
            self.send_header('Content-type', 'text/plain')
            self.end_headers()
            self.wfile.write(str(STATE["colorTemperature"]).encode())
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        content_length = int(self.headers.get('Content-Length', 0))
        post_data = self.rfile.read(content_length).decode()
        # Support /brightness/<value>, /hue/<value>, etc.
        path_parts = self.path.strip('/').split('/')
        if self.path == "/on":
            STATE["on"] = True
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'OK')
        elif self.path == "/off":
            STATE["on"] = False
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'OK')
        elif path_parts[0] == "brightness":
            try:
                value = int(path_parts[1]) if len(path_parts) > 1 else int(post_data)
                STATE["brightness"] = value
            except Exception:
                pass
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'OK')
        elif path_parts[0] == "hue":
            try:
                value = int(path_parts[1]) if len(path_parts) > 1 else int(post_data)
                STATE["hue"] = value
            except Exception:
                pass
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'OK')
        elif path_parts[0] == "saturation":
            try:
                value = int(path_parts[1]) if len(path_parts) > 1 else int(post_data)
                STATE["saturation"] = value
            except Exception:
                pass
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'OK')
        elif path_parts[0] == "colortemperature":
            try:
                value = int(path_parts[1]) if len(path_parts) > 1 else int(post_data)
                STATE["colorTemperature"] = value
            except Exception:
                pass
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'OK')
        else:
            self.send_response(404)
            self.end_headers()

if __name__ == "__main__":
    server_address = ('', 8000)
    httpd = HTTPServer(server_address, DummyLightbulbHandler)
    print("Dummy Lightbulb server running on port 8000...")
    httpd.serve_forever()