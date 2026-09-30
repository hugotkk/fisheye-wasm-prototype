import sys, json
from playwright.sync_api import sync_playwright

CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=CHROME_PATH, headless=True)
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    logs = []
    page.on("console", lambda msg: logs.append(f"[{msg.type}] {msg.text}"))
    page.on("pageerror", lambda exc: logs.append(f"[pageerror] {exc}"))

    caps = page.evaluate("""() => {
        const c = document.createElement('canvas');
        const gl2 = c.getContext('webgl2');
        const gl1 = !gl2 && (c.getContext('webgl') || c.getContext('experimental-webgl'));
        const gl = gl2 || gl1;
        return {
            webgl2: !!gl2,
            webgl1: !!gl1,
            maxTextureSize: gl ? gl.getParameter(gl.MAX_TEXTURE_SIZE) : null,
            renderer: gl ? gl.getParameter(gl.RENDERER) : null,
            vendor: gl ? gl.getParameter(gl.VENDOR) : null,
        };
    }""") if False else None

    page.goto("http://127.0.0.1:8765/index.html", wait_until="networkidle")

    caps = page.evaluate("""() => {
        const c = document.createElement('canvas');
        const gl2 = c.getContext('webgl2');
        const gl1 = !gl2 && (c.getContext('webgl') || c.getContext('experimental-webgl'));
        const gl = gl2 || gl1;
        return {
            webgl2: !!gl2,
            webgl1: !!gl1,
            maxTextureSize: gl ? gl.getParameter(gl.MAX_TEXTURE_SIZE) : null,
            renderer: gl ? gl.getParameter(gl.RENDERER) : null,
            vendor: gl ? gl.getParameter(gl.VENDOR) : null,
        };
    }""")
    print("CAPS:", json.dumps(caps))

    file_input = page.locator("#file")
    file_input.set_input_files("/tmp/synthetic_dualfisheye.jpg")

    page.click("#go")
    page.wait_for_function("document.getElementById('status').textContent.startsWith('done')", timeout=60000)

    status = page.text_content("#status")
    log_text = page.text_content("#log")
    print("STATUS:", status)
    print("LOG:\n", log_text)

    page.screenshot(path="/tmp/prototype_screenshot.png", full_page=True)

    # Export the rendered canvas to a PNG file for pixel comparison.
    data_url = page.evaluate("document.getElementById('preview').toDataURL('image/png')")
    import base64
    b64 = data_url.split(",", 1)[1]
    with open("/tmp/prototype_output.png", "wb") as f:
        f.write(base64.b64decode(b64))

    print("CONSOLE LOGS:")
    for l in logs:
        print(l)

    browser.close()
