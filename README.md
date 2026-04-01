# VirtualFieldtrip JSON File Format (`.VFJF`)

> **Hi Stride Peoples:** Demo available [here](https://xrl404.github.io/K12/VF_Guide/Main.html?file=K12/VF_Guide/Virtual_Fieldtrips/Louvre_Museum/Louvre_Museum.VFJF). If i was not supposed to use Stride assets, please reach out and they will be removed.

---

## URL Format

```
?file=K12/Virtual_Fieldtrips/TripName/TripName.VFJF
```

---

## File Structure

```json
{
  "root":            "Trip Title",
  "start_node":      "node_id",
  "thank_you":       "audio/thankyou.mp3",
  "thank_you_text":  "Thanks for joining us!",
  "nodes": {
    "node_id": {
      "text":    "Narrator text shown in the card.",
      "audio":   "audio/node.mp3",
      "end":     true,
      "choices": [
        { "text": "Choice label",  "next": "other_node_id" },
        { "text": "Let's go back", "next": "prev_node_id", "back": true },
        { "text": "End tour",      "next": "end",          "end": true }
      ]
    }
  }
}
```

### Top-Level Fields

| Field            | Required | Description |
|------------------|----------|-------------|
| `root`           | ✅       | Trip title |
| `start_node`     | ✅       | ID of the first node |
| `thank_you`      | ❌       | Audio file played on completion |
| `thank_you_text` | ❌       | Text shown in the completion banner |
| `nodes`          | ✅       | Map of node IDs to node objects |

### Node Fields

| Field     | Required | Description |
|-----------|----------|-------------|
| `text`    | ✅       | Narrator text displayed in the card |
| `audio`   | ❌       | Relative path to a narration audio file |
| `end`     | ❌       | If `true`, marks this branch complete without requiring a visit |
| `choices` | ✅       | List of choice objects |

### Choice Fields

| Field  | Required | Description |
|--------|----------|-------------|
| `text` | ✅       | Button label |
| `next` | ✅       | Node ID to go to, or `"end"` to finish the tour |
| `back` | ❌       | If `true`, navigates back — no audio plays |
| `end`  | ❌       | If `true`, triggers end-of-trip completion |

---

## Dev Tools

In the browser console:

```js
VFT.fastMode()       // Caps audio to ~0.1s for fast testing
VFT.fastMode(false)  // Restores normal playback
```
