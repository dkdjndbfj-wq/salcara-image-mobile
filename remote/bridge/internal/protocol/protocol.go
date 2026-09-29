// Package protocol holds the wire types shared by the bridge, the hub and the phone app (docs/PROTOCOL.md).
package protocol

type Tool struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Available bool   `json:"available"`
	Version   string `json:"version,omitempty"`
}

type Project struct {
	Path string `json:"path"`
	Name string `json:"name"`
}

type Device struct {
	DeviceID string    `json:"deviceId"`
	Name     string    `json:"name"`
	OS       string    `json:"os"`
	Version  string    `json:"version"`
	Tools    []Tool    `json:"tools"`
	Projects []Project `json:"projects"`
}

type SessionInfo struct {
	SessionKey   string `json:"sessionKey"`
	Tool         string `json:"tool"`
	Client       string `json:"client"`
	Title        string `json:"title"`
	Cwd          string `json:"cwd"`
	UpdatedAt    int64  `json:"updatedAt"`
	Status       string `json:"status"` // running | idle | waiting_approval | failed
	Controllable bool   `json:"controllable"`
	Model        string `json:"model,omitempty"`
}

// Event is one timeline item. Only the fields relevant to Type are set.
type Event struct {
	Seq        int64        `json:"seq,omitempty"`
	DeviceID   string       `json:"deviceId,omitempty"`
	SessionKey string       `json:"sessionKey"`
	Tool       string       `json:"tool"`
	TS         int64        `json:"ts"`
	Type       string       `json:"type"` // session.updated | message | reasoning | tool | approval.request | approval.resolved | turn | notice
	Session    *SessionInfo `json:"session,omitempty"`

	ID    string `json:"id,omitempty"`
	Role  string `json:"role,omitempty"`
	Text  string `json:"text,omitempty"`
	Final bool   `json:"final,omitempty"`

	Kind     string `json:"kind,omitempty"`
	Title    string `json:"title,omitempty"`
	Detail   string `json:"detail,omitempty"`
	Status   string `json:"status,omitempty"`
	Output   string `json:"output,omitempty"`
	Diff     string `json:"diff,omitempty"`
	ExitCode *int   `json:"exitCode,omitempty"`
	Cwd      string `json:"cwd,omitempty"`

	ApprovalID string `json:"approvalId,omitempty"`
	Decision   string `json:"decision,omitempty"`
	By         string `json:"by,omitempty"`

	Error string `json:"error,omitempty"`
	Usage *Usage `json:"usage,omitempty"`
	Level string `json:"level,omitempty"`
}

type Usage struct {
	InputTokens  int64   `json:"inputTokens"`
	OutputTokens int64   `json:"outputTokens"`
	CostUSD      float64 `json:"costUsd,omitempty"`
}

// Command is what the phone asks the bridge to do (type + params kept raw for the handler).
type CommandEnvelope struct {
	CommandID string         `json:"commandId"`
	DeviceID  string         `json:"deviceId"`
	Command   map[string]any `json:"command"`
}

type Reply struct {
	DeviceID  string `json:"deviceId"`
	CommandID string `json:"commandId"`
	OK        bool   `json:"ok"`
	Result    any    `json:"result,omitempty"`
	Error     string `json:"error,omitempty"`
}
