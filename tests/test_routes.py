from fastapi.testclient import TestClient
from musicweb import app

client = TestClient(app, headers={"Cf-Access-Authenticated-User-Email": "test@test.com"})

def test_root_returns_html():
    resp = client.get("/")
    assert resp.status_code == 200
    assert "text/html" in resp.headers["content-type"]

def test_queue_returns_json():
    resp = client.get("/queue")
    assert resp.status_code == 200
    data = resp.json()
    assert "my_jobs" in data
    assert "all_jobs" in data
    assert "comfyui" in data
