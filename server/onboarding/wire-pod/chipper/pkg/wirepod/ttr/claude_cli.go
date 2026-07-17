package wirepod_ttr

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"

	"github.com/kercre123/wire-pod/chipper/pkg/logger"
	"github.com/sashabaranov/go-openai"
)

// ClaudeCLIStream implements ChatStream by running `claude -p` as a child process
// and reading stdout incrementally.
type ClaudeCLIStream struct {
	cmd    *exec.Cmd
	reader *bufio.Reader
	done   bool
	mu     sync.Mutex
}

// NewClaudeCLIStream creates a new streaming response from Claude CLI.
// Follows the same pattern as vector-bot/bot.py _call_claude_cli().
func NewClaudeCLIStream(ctx context.Context, messages []openai.ChatCompletionMessage, model string) (*ClaudeCLIStream, error) {
	// Separate system prompt from user/assistant messages
	var systemPrompt string
	var userPrompt strings.Builder
	for _, msg := range messages {
		switch msg.Role {
		case "system":
			systemPrompt = msg.Content
		case "user":
			if userPrompt.Len() > 0 {
				userPrompt.WriteString("\n")
			}
			userPrompt.WriteString("User: ")
			userPrompt.WriteString(msg.Content)
		case "assistant":
			if msg.Content != "" {
				userPrompt.WriteString("\nAssistant: ")
				userPrompt.WriteString(msg.Content)
			}
		}
	}

	promptText := strings.TrimSpace(userPrompt.String())

	// Find claude binary - check common locations since GUI apps have limited PATH
	claudeBin := "claude"
	for _, p := range []string{
		os.Getenv("HOME") + "/.local/bin/claude",
		"/usr/local/bin/claude",
		"/opt/homebrew/bin/claude",
	} {
		if _, err := os.Stat(p); err == nil {
			claudeBin = p
			break
		}
	}

	args := []string{
		"-p",
		"--model", model,
		"--allowedTools", "WebSearch",
	}
	// Append web search instructions to system prompt
	webSearchNote := " When using web search, NEVER include URLs or links in your response. Just mention the source name briefly (like 'according to Yahoo Finance'). Only use web search for questions that need current real-time data (prices, news, weather, scores). For casual conversation or general knowledge, answer directly without searching."
	fullSystemPrompt := systemPrompt + webSearchNote
	args = append(args, "--system-prompt", fullSystemPrompt)

	logger.Println("Using Claude CLI: " + claudeBin + " model: " + model)
	logPrompt := promptText
	if len(logPrompt) > 200 {
		logPrompt = logPrompt[:200] + "..."
	}
	logger.Println("Claude prompt (" + fmt.Sprintf("%d", len(promptText)) + " chars): " + logPrompt)

	cmd := exec.CommandContext(ctx, claudeBin, args...)
	// Pass prompt via stdin (same as bot.py proc.communicate(input=...))
	cmd.Stdin = bytes.NewReader([]byte(promptText))
	// Clear CLAUDECODE env var to avoid nested session detection
	cmd.Env = filterEnv(os.Environ(), "CLAUDECODE")

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("failed to create stdout pipe: %w", err)
	}

	// Capture stderr for debugging
	var stderrBuf bytes.Buffer
	cmd.Stderr = &stderrBuf

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("failed to start claude CLI: %w", err)
	}

	return &ClaudeCLIStream{
		cmd:    cmd,
		reader: bufio.NewReaderSize(stdout, 256),
	}, nil
}

// filterEnv returns env without the specified key
func filterEnv(env []string, key string) []string {
	prefix := key + "="
	var filtered []string
	for _, e := range env {
		if !strings.HasPrefix(e, prefix) {
			filtered = append(filtered, e)
		}
	}
	return filtered
}

// Recv reads the next chunk of text from Claude CLI stdout.
// Returns io.EOF when the process has finished writing.
func (s *ClaudeCLIStream) Recv() (openai.ChatCompletionStreamResponse, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.done {
		return openai.ChatCompletionStreamResponse{}, io.EOF
	}

	buf := make([]byte, 256)
	n, _ := s.reader.Read(buf)
	if n > 0 {
		text := string(buf[:n])
		return openai.ChatCompletionStreamResponse{
			Choices: []openai.ChatCompletionStreamChoice{
				{
					Delta: openai.ChatCompletionStreamChoiceDelta{
						Content: text,
					},
				},
			},
		}, nil
	}

	// EOF or error — process finished
	s.done = true
	waitErr := s.cmd.Wait()
	// Always log stderr for debugging
	if stderr := s.cmd.Stderr; stderr != nil {
		if buf, ok := stderr.(*bytes.Buffer); ok && buf.Len() > 0 {
			logger.Println("Claude CLI stderr: " + buf.String())
		} else {
			logger.Println("Claude CLI stderr: (empty)")
		}
	}
	if waitErr != nil {
		logger.Println("Claude CLI exit error: " + waitErr.Error())
		return openai.ChatCompletionStreamResponse{}, fmt.Errorf("claude CLI exit: %v", waitErr)
	}
	logger.Println("Claude CLI exited successfully (code 0)")
	return openai.ChatCompletionStreamResponse{}, io.EOF
}

// Close kills the Claude CLI process if still running.
func (s *ClaudeCLIStream) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.done {
		return nil
	}
	s.done = true

	if s.cmd.Process != nil {
		s.cmd.Process.Kill()
		s.cmd.Wait()
	}
	return nil
}
