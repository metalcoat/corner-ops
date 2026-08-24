"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import "./wallboard.css";

const DISPLAY_TOKEN_KEY = "corner_ops_deli_board_token";
const REFRESH_MS = 60_000;

type Task = {
  id: string;
  title: string;
  category: string;
  completed: boolean;
  completed_by?: string;
  completed_at?: string | null;
};

type Message = {
  id: string;
  sender_name: string;
  message_type: string;
  body: string;
  created_at: string;
};

type Call = {
  historyId: string;
  droppedAt: string;
  caller: string;
  waitSeconds: number;
  assessment: string;
  reason: string;
  resolved: boolean;
};

type Shift = {
  id: string;
  employee_name: string;
  position: string;
  starts_at: string;
  ends_at: string;
  status: string;
};

type BoardPayload = {
  business: "Corner Deli";
  generatedAt: string;
  workDate: string;
  tasks: Task[];
  taskSummary: { total: number; completed: number; remaining: number };
  messages: Message[];
  schedule: Shift[];
  calls: Call[];
  callSummary: { unresolved: number; meaningful: number; issues: number; busy: number };
  callError: string;
};

function formatTime(value: string) {
  return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function relative(value: string) {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(value).toLocaleDateString([], { month: "short", day: "numeric" });
}

function phone(value: string) {
  const digits = String(value || "").replace(/\D/g, "").slice(-10);
  if (digits.length !== 10) return value || "Unknown caller";
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function firstName(value: string) {
  const text = String(value || "").trim();
  if (!text) return "Unknown";
    const part = text.includes("@") ? text.split("@")[0].split(/[._-]/)[0] : text.split(/\s+/)[0];
  return part.charAt(0).toUpperCase() + part.slice(1);
}

function displayToken() {
  return typeof window === "undefined" ? "" : window.localStorage.getItem(DISPLAY_TOKEN_KEY) || "";
}

function requestHeaders(json = false): Record<string, string> {
  const headers: Record<string, string> = {};
  const token = displayToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (json) headers["Content-Type"] = "application/json";
  return headers;
}

async function responseError(response: Response) {
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  return payload?.error || `Request failed (${response.status}).`;
}

export default function DeliBoardPage() {
  const [data, setData] = useState<BoardPayload | null>(null);
  const [now, setNow] = useState(new Date());
  const [notice, setNotice] = useState("");
  const [busyTask, setBusyTask] = useState("");
  const [signedOut, setSignedOut] = useState(false);
  const loadingRef = useRef(false);

  async function load() {
    if (loadingRef.current) return;
    loadingRef.current = true;
    try {
      const response = await fetch("/api/deli-board", { cache: "no-store", headers: requestHeaders() });
      if (response.status === 401) {
        window.localStorage.removeItem(DISPLAY_TOKEN_KEY);
        setSignedOut(true);
        return;
      }
      if (!response.ok) throw new Error(await responseError(response));
      setSignedOut(false);
      setData(await response.json() as BoardPayload);
      setNotice("");
    } finally {
      loadingRef.current = false;
    }
  }

  useEffect(() => {
    void load().catch((error) => setNotice(error instanceof Error ? error.message : "Dashboard unavailable."));
    const refresh = window.setInterval(() => {
      if (document.visibilityState === "visible") void load().catch(() => undefined);
    }, REFRESH_MS);
    const clock = window.setInterval(() => setNow(new Date()), 1_000);
    return () => {
      window.clearInterval(refresh);
      window.clearInterval(clock);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function toggleTask(task: Task) {
    setBusyTask(task.id);
    try {
      const response = await fetch("/api/deli-board", {
        method: "POST",
        headers: requestHeaders(true),
        body: JSON.stringify({ action: "toggle-task", taskId: task.id, completed: !task.completed }),
      });
      if (response.status === 401) {
        window.localStorage.removeItem(DISPLAY_TOKEN_KEY);
        setSignedOut(true);
        return;
      }
      if (!response.ok) throw new Error(await responseError(response));
      setData(await response.json() as BoardPayload);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Task could not be updated.");
    } finally {
      setBusyTask("");
    }
  }

  async function addTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const title = String(formData.get("title") || "").trim();
    if (!title) return;
    try {
      const response = await fetch("/api/deli-board", {
        method: "POST",
        headers: requestHeaders(true),
        body: JSON.stringify({ action: "add-task", title, category: "Today" }),
      });
      if (response.status === 401) {
        window.localStorage.removeItem(DISPLAY_TOKEN_KEY);
        setSignedOut(true);
        return;
      }
      if (!response.ok) throw new Error(await responseError(response));
      setData(await response.json() as BoardPayload);
      form.reset();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Task could not be added.");
    }
  }

  const schedule = useMemo(() => {
    const timestamp = now.getTime();
    return (data?.schedule || []).map((shift) => ({
      ...shift,
      current: new Date(shift.starts_at).getTime() <= timestamp && new Date(shift.ends_at).getTime() > timestamp,
    }));
  }, [data?.schedule, now]);

  if (signedOut) {
    return <main className="deliBoard signedOut">
      <section><h1>Deli Board</h1><p>This display needs a Corner Deli employee PIN.</p><a href="/deli-board/login">Open PIN login</a></section>
    </main>;
  }

  if (!data) {
    return <main className="deliBoard loading"><strong>Loading Deli Board…</strong>{notice && <span>{notice}</span>}</main>;
  }

  const progress = data.taskSummary.total ? Math.round((data.taskSummary.completed / data.taskSummary.total) * 100) : 100;
  const incompleteTasks = data.tasks.filter((task) => !task.completed);
  const completedTasks = data.tasks.filter((task) => task.completed);
  const visibleTasks = [...incompleteTasks, ...completedTasks].slice(0, 14);
  const currentStaff = schedule.filter((shift) => shift.current);
  const upcomingStaff = schedule.filter((shift) => !shift.current && new Date(shift.starts_at).getTime() > now.getTime()).slice(0, 5);
  const generatedAt = new Date(data.generatedAt).getTime();
  const staleMinutes = Number.isFinite(generatedAt) ? Math.max(0, Math.floor((now.getTime() - generatedAt) / 60_000)) : 999;
  const stale = staleMinutes >= 3;

  return <main className="deliBoard">
    <header className="boardHeader">
      <div className="boardBrand"><span className="boardDot" /><div><strong>Corner Deli</strong><small>Live Operations Board</small></div></div>
      <div className="boardClock"><strong>{now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</strong><span>{now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}</span></div>
      <div className="boardHeaderActions"><span>Refreshes every 60s</span><button onClick={() => document.documentElement.requestFullscreen?.()}>Fullscreen</button></div>
    </header>

    {notice && <div className="boardNotice">{notice}</div>}
    {stale && <div className="boardNotice">Live data is stale: the last successful board refresh was {staleMinutes} minute{staleMinutes === 1 ? "" : "s"} ago.</div>}

    <section className="boardStats">
      <article><span>Tasks remaining</span><strong>{data.taskSummary.remaining}</strong><small>{progress}% complete</small></article>
      <article className={data.callSummary.unresolved ? "attention" : ""}><span>Missed calls</span><strong>{data.callSummary.unresolved}</strong><small>{data.callSummary.issues ? `${data.callSummary.issues} need attention` : "No unresolved issues"}</small></article>
      <article><span>Working now</span><strong>{currentStaff.length}</strong><small>{currentStaff.map((shift) => firstName(shift.employee_name)).join(", ") || "No scheduled staff"}</small></article>
      <article><span>Team messages</span><strong>{data.messages.length}</strong><small>Last 3 days</small></article>
    </section>

    <section className="boardGrid">
      <article className="boardPanel tasksPanel">
        <header><div><span className="panelKicker">TODAY</span><h2>Tasks</h2></div><strong>{data.taskSummary.completed}/{data.taskSummary.total}</strong></header>
        <div className="taskProgress"><span style={{ width: `${progress}%` }} /></div>
        <div className="taskList">
          {visibleTasks.map((task) => <button key={task.id} disabled={busyTask === task.id} className={`taskRow ${task.completed ? "done" : ""}`} onClick={() => void toggleTask(task)}>
            <span className="taskCheck">{task.completed ? "✓" : ""}</span>
            <span className="taskText"><strong>{task.title}</strong><small>{task.category}{task.completed_by ? ` · ${firstName(task.completed_by)}` : ""}</small></span>
          </button>)}
        </div>
        <form className="quickTask" onSubmit={addTask}><input aria-label="Quick task title" name="title" placeholder="Add quick task…" autoComplete="off" /><button>Add</button></form>
      </article>

      <article className="boardPanel messagesPanel">
        <header><div><span className="panelKicker">TEAM</span><h2>Messages</h2></div><span className="livePill">LIVE</span></header>
        <div className="messageList">
          {data.messages.slice(0, 8).map((message) => <div className="messageRow" key={message.id}>
            <div className="messageAvatar">{firstName(message.sender_name).slice(0, 1)}</div>
            <div><header><strong>{firstName(message.sender_name)}</strong><small>{relative(message.created_at)}</small></header><p>{message.body}</p></div>
          </div>)}
          {!data.messages.length && <div className="emptyState">No team messages yet.</div>}
        </div>
      </article>

      <article className="boardPanel callsPanel">
        <header><div><span className="panelKicker">PHONES</span><h2>Missed Calls</h2></div><strong className={data.callSummary.unresolved ? "callCount hot" : "callCount"}>{data.callSummary.unresolved}</strong></header>
        {data.callError && <div className="feedError">{data.callError}</div>}
        <div className="callList">
          {data.calls.slice(0, 6).map((call) => <div className="callRow" key={call.historyId}>
            <span className={`callIcon ${call.assessment.toLowerCase().replaceAll(" ", "-")}`}>☎</span>
            <div><strong>{phone(call.caller)}</strong><span>{formatTime(call.droppedAt)} · waited {call.waitSeconds}s</span></div>
            <small>{call.assessment}</small>
          </div>)}
          {!data.calls.length && !data.callError && <div className="emptyState good">✓ No unresolved missed calls</div>}
        </div>
      </article>

      <article className="boardPanel staffingPanel">
        <header><div><span className="panelKicker">FLOOR</span><h2>Staffing</h2></div></header>
        <div className="staffSection"><span>Working now</span>{currentStaff.map((shift) => <div className="staffRow current" key={shift.id}><strong>{shift.employee_name}</strong><small>{shift.position} · until {formatTime(shift.ends_at)}</small></div>)}{!currentStaff.length && <div className="emptyState">Nobody scheduled right now.</div>}</div>
        <div className="staffSection"><span>Coming up</span>{upcomingStaff.map((shift) => <div className="staffRow" key={shift.id}><strong>{shift.employee_name}</strong><small>{formatTime(shift.starts_at)} · {shift.position}</small></div>)}{!upcomingStaff.length && <div className="emptyState">No upcoming shifts in the next 12 hours.</div>}</div>
      </article>
    </section>

    <footer className="boardFooter"><span>Corner Ops</span><span>Last sync {formatTime(data.generatedAt)}</span></footer>
  </main>;
}
