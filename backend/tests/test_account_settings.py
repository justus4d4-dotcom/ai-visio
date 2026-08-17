from __future__ import annotations

from app.routers import account


def test_settings_save_preserves_server_managed_device_profiles(monkeypatch) -> None:
    saved: dict[str, object] = {}

    monkeypatch.setattr(account.auth, "current_user_key", lambda request: "owner@example.com")
    monkeypatch.setattr(
        account.settings_store,
        "get_settings",
        lambda db, user_key: {
            "provider": {"model": "gemini-test"},
            "device_profiles": {"AA:BB:CC:DD:EE:FF": {"ip_address": "192.168.1.24"}},
        },
    )
    monkeypatch.setattr(
        account.settings_store,
        "set_settings",
        lambda db, user_key, data: saved.update(data),
    )

    account.put_settings(
        account.SettingsBody(settings={"display": {"brightness": 180}}),
        object(),
        object(),
    )

    assert saved["display"] == {"brightness": 180}
    assert saved["provider"] == {"model": "gemini-test"}
    assert saved["device_profiles"] == {
        "AA:BB:CC:DD:EE:FF": {"ip_address": "192.168.1.24"}
    }
