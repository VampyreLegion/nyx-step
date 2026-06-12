import core.db as db


def _seed_history(user="insight@test.com"):
    rows = [
        ("synthwave, dreamy, analog", 8.5),
        ("synthwave, driving, retro", 7.5),
        ("acoustic folk, warm", 4.0),
        ("acoustic folk, gentle", 5.0),
        ("jazz, smooth", None),  # unscored — excluded from averages
    ]
    for caption, quality in rows:
        fname = f"f_{abs(hash((user, caption)))}.mp3"
        db.append_history(
            prompt_id="t-" + caption[:8], user_email=user,
            song_name="s", caption=caption, lyrics="", seed=1,
            output_files=[fname], params={},
        )
        if quality is not None:
            db.set_history_quality(fname, quality)


def test_set_and_aggregate_quality():
    _seed_history()
    insights = db.get_tag_insights("insight@test.com")
    by_tag = {i["tag"]: i for i in insights}
    assert by_tag["synthwave"]["count"] == 2
    assert by_tag["synthwave"]["avg_quality"] == 8.0
    assert by_tag["acoustic folk"]["avg_quality"] == 4.5
    assert "jazz" not in by_tag  # unscored rows excluded


def test_insights_endpoint():
    from fastapi.testclient import TestClient
    from nyx_step import app
    _seed_history(user="dev@local")  # TestClient resolves to dev@local
    client = TestClient(app)
    data = client.get("/api/history/insights").json()
    assert "tags" in data
    by_tag = {t["tag"]: t for t in data["tags"]}
    assert by_tag.get("synthwave", {}).get("count") == 2
