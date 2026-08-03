"use client";

import { FormEvent, useEffect, useState } from "react";
import type { Business, SessionView } from "@/lib/types";
import "../control-center.css";

type User = {
  id: string;
  email: string;
  displayName: string;
  role: string;
  businesses: Business[];
  permissions: string[];
  active: boolean;
  createdBy: string;
  createdAt: string;
  legacyOwner: boolean;
  passwordSet: boolean;
};

async function message(response: Response): Promise<string> {
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  return payload?.error || `Request failed (${response.status}).`;
}

export default function UsersPage() {
  const [session, setSession] = useState<SessionView | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);

  useEffect(() => {
    fetch("/api/auth/session", { cache: "no-store" })
      .then((response) => response.json())
      .then(setSession)
      .catch(() => setNotice("Unable to load the current session."));
  }, []);

  async function load(): Promise<void> {
    const response = await fetch("/api/users", { cache: "no-store" });
    if (!response.ok) throw new Error(await message(response));
    const payload = await response.json() as { users: User[] };
    setUsers(payload.users);
  }

  useEffect(() => {
    if (session?.authenticated) load().catch((error) => setNotice(error.message));
  }, [session?.authenticated]);

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setNotice("");
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: editing?.id,
          email: form.get("email"),
          displayName: form.get("displayName"),
          role: form.get("role"),
          businesses: [
            form.get("cornerDeli") === "on" ? "Corner Deli" : null,
            form.get("tiki") === "on" ? "Tiki" : null,
          ].filter(Boolean),
          password: form.get("password") || undefined,
          active: true,
        }),
      });
      if (!response.ok) throw new Error(await message(response));
      const wasPending = Boolean(editing && !editing.passwordSet);
      event.currentTarget.reset();
      setEditing(null);
      await load();
      setNotice(wasPending ? "Account activated with its first password." : editing ? "User updated." : "User created.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function setActive(user: User): Promise<void> {
    setBusy(true);
    try {
      const response = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "active", id: user.id, active: !user.active }),
      });
      if (!response.ok) throw new Error(await message(response));
      await load();
      setNotice(`${user.displayName} is now ${user.active ? "inactive" : "active"}.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  if (!session) return <main className="controlPage">Loading users…</main>;
  if (!session.authenticated) return <main className="controlPage"><a href="/signin">Sign in</a></main>;

  const passwordRequired = !editing || !editing.passwordSet;

  return <main className="controlPage">
    <header className="controlHeader">
      <div>
        <p className="eyebrow">Access control</p>
        <h1>Corner Ops users</h1>
        <p>Separate accounts, scoped businesses, and roles. One shared password has finally been relieved of governing an empire.</p>
      </div>
      <div className="controlActions"><a href="/ops">Operations</a><a href="/signin">User sign-in</a></div>
    </header>

    {notice && <div className="noticeBar">{notice}</div>}

    <div className="controlGrid">
      <section className="controlCard half">
        <p className="eyebrow">{editing ? "Edit account" : "New account"}</p>
        <h2>{editing?.displayName || "Add user"}</h2>
        {editing && !editing.passwordSet && <div className="noticeBar">This account exists but cannot sign in until you set its first password.</div>}
        <form className="controlForm" onSubmit={save} key={editing?.id || "new"}>
          <label>Name<input name="displayName" defaultValue={editing?.displayName || ""} required /></label>
          <label>Email<input name="email" type="email" defaultValue={editing?.email || ""} required /></label>
          <label>Role<select name="role" defaultValue={editing?.role || "Viewer"}>
            <option>Co-Owner</option><option>Accountant</option><option>Manager</option><option>Viewer</option>
            {editing?.role === "Owner" && <option>Owner</option>}
          </select></label>
          <label>{editing?.passwordSet ? "New password, optional" : "First password"}
            <input name="password" type="password" minLength={10} required={passwordRequired} />
          </label>
          <label><span><input name="cornerDeli" type="checkbox" defaultChecked={editing ? editing.businesses.includes("Corner Deli") : true} /> Corner Deli</span></label>
          <label><span><input name="tiki" type="checkbox" defaultChecked={editing ? editing.businesses.includes("Tiki") : true} /> Tiki</span></label>
          <div className="controlActions wide">
            <button className="primary" disabled={busy}>{editing ? (editing.passwordSet ? "Save user" : "Set password and activate") : "Create user"}</button>
            {editing && <button type="button" onClick={() => setEditing(null)}>Cancel</button>}
          </div>
        </form>
      </section>

      <section className="controlCard half">
        <p className="eyebrow">Role map</p><h2>Permissions</h2>
        <div className="list">
          <div className="listItem"><strong>Owner / Co-Owner</strong><span>Everything within assigned businesses</span></div>
          <div className="listItem"><strong>Accountant</strong><span>Accounting, integrations, payroll and reports</span></div>
          <div className="listItem"><strong>Manager</strong><span>Payroll, workforce, documents and reports</span></div>
          <div className="listItem"><strong>Viewer</strong><span>Read-only operating visibility and reports</span></div>
        </div>
      </section>

      <section className="controlCard">
        <p className="eyebrow">Active directory</p><h2>Users</h2>
        <div className="tableWrap"><table className="controlTable">
          <thead><tr><th>User</th><th>Role</th><th>Businesses</th><th>Status</th><th>Created</th><th>Actions</th></tr></thead>
          <tbody>{users.map((user) => <tr key={user.id}>
            <td><strong>{user.displayName}</strong><small>{user.email}</small></td>
            <td>{user.role}</td>
            <td>{user.businesses.join(" · ")}</td>
            <td>
              <span className={`badge ${user.active ? "good" : "bad"}`}>{user.active ? "Active" : "Inactive"}</span>{" "}
              {!user.passwordSet && <span className="badge warn">Password needed</span>}
            </td>
            <td>{new Date(user.createdAt).toLocaleDateString()}<small>{user.createdBy}</small></td>
            <td>
              <button onClick={() => setEditing(user)}>{user.passwordSet ? "Edit" : "Set password"}</button>{" "}
              <button onClick={() => setActive(user)} disabled={busy || user.role === "Owner"}>{user.active ? "Deactivate" : "Reactivate"}</button>
            </td>
          </tr>)}</tbody>
        </table></div>
      </section>
    </div>
  </main>;
}
