package main

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func testQueue() *outputQueue {
	return newOutputQueue(queueDeps{
		workspacePath:          "/ws",
		getCanvasPath:          func() string { return "/ws/home" },
		resolveCanvasReference: func(s string) string { return s },
		isCanvasScope:          func(s string) bool { return s == "" || s == "/ws/home" },
		shortText:              func(s string) string { return s },
		logf:                   func(kind, msg string) {},
	})
}

// TestQueueSerialDispatch: two pending jobs run one at a time, in order — never
// concurrently — and the lane frees for the next when the first finishes.
func TestQueueSerialDispatch(t *testing.T) {
	q := testQueue()
	defer q.close()

	var concurrent int32
	var maxConcurrent int32
	var order []string
	var mu sync.Mutex
	done := make(chan struct{}, 2)

	q.setProcessJob(func(job *outputJob) {
		n := atomic.AddInt32(&concurrent, 1)
		if n > atomic.LoadInt32(&maxConcurrent) {
			atomic.StoreInt32(&maxConcurrent, n)
		}
		mu.Lock()
		order = append(order, job.ID)
		mu.Unlock()
		time.Sleep(40 * time.Millisecond)
		// The processor owns moving the job out of 'pending' (as
		// processOutputJob does via updateOutputJob), so it isn't re-dispatched.
		q.updateOutputJob(job.ID, func(j *outputJob) { j.Status = "done" })
		atomic.AddInt32(&concurrent, -1)
		done <- struct{}{}
	})

	q.appendOutputJob(&outputJob{ID: "a", Status: "pending", Scope: "components/foo", Prompt: "one"})
	q.appendOutputJob(&outputJob{ID: "b", Status: "pending", Scope: "components/bar", Prompt: "two"})
	q.feedHermesOutput()

	for i := 0; i < 2; i++ {
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			t.Fatalf("jobs did not complete; ran %v", order)
		}
	}

	if maxConcurrent != 1 {
		t.Errorf("maxConcurrent = %d; want 1 (serial lane)", maxConcurrent)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(order) != 2 || order[0] != "a" || order[1] != "b" {
		t.Errorf("dispatch order = %v; want [a b]", order)
	}
}

// TestQueueInsertNext: an inserted job jumps ahead of pending work.
func TestQueueInsertNext(t *testing.T) {
	q := testQueue()
	defer q.close()

	q.appendOutputJob(&outputJob{ID: "first", Status: "pending", Prompt: "x"})
	q.appendOutputJob(&outputJob{ID: "second", Status: "pending", Prompt: "y"})
	q.insertOutputJobNext(&outputJob{ID: "jump", Status: "pending", Prompt: "z"})

	q.mu.Lock()
	got := []string{q.jobs[0].ID, q.jobs[1].ID, q.jobs[2].ID}
	q.mu.Unlock()
	if got[0] != "jump" {
		t.Errorf("insertOutputJobNext order = %v; want jump first", got)
	}
}

func TestBuildJobPrompt(t *testing.T) {
	getCanvas := func() string { return "/ws/home" }

	// Canvas-root scope -> directory path with trailing separator.
	p := buildJobPrompt(&outputJob{Scope: "", Prompt: "do it"}, getCanvas)
	want := "Scope:\n/ws/home/\n\nPrompt:\ndo it"
	if p != want {
		t.Errorf("buildJobPrompt(canvas) =\n%q\nwant\n%q", p, want)
	}

	// Component scope -> resolved path.
	p = buildJobPrompt(&outputJob{Scope: "components/foo", Prompt: "fix"}, getCanvas)
	want = "Scope:\n/ws/home/components/foo\n\nPrompt:\nfix"
	if p != want {
		t.Errorf("buildJobPrompt(component) =\n%q\nwant\n%q", p, want)
	}
}

func TestCurrentBusyState(t *testing.T) {
	q := testQueue()
	defer q.close()
	q.appendOutputJob(&outputJob{ID: "r", Status: "running", Scope: "components/foo", ComponentKey: "components/foo", Prompt: "p"})

	// Matching component key -> busy.
	st := q.currentBusyState("components/foo")
	if st["busy"] != true {
		t.Errorf("expected busy for matching lane, got %v", st)
	}
	// Unrelated key -> not busy.
	st = q.currentBusyState("components/other")
	if st["busy"] != false {
		t.Errorf("expected not busy for unrelated lane, got %v", st)
	}
}
