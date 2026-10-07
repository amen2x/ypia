// User-triggered actions shared by more than one view.

import { setTaskStatus, touch } from "./store.js";
import { showToast } from "./ui.js";

export const busyTasks = new Set();

// Marks a task done (or reopens it). Only changes the UI once the server confirms.
export async function toggleTask(task) {
  if (busyTasks.has(task.id)) return;
  const next = task.status === "done" ? "open" : "done";
  busyTasks.add(task.id);
  touch();
  try {
    await setTaskStatus(task, next);
    showToast(next === "done" ? "Task marked done." : "Task reopened.");
  } catch (error) {
    showToast(`Couldn't update that task. ${error.message}`, true);
  } finally {
    busyTasks.delete(task.id);
    touch();
  }
}
