# ralph.sh
# Usage: ./ralph.sh <iterations>

set -e

if [ -z "$1" ]; then
  echo "Usage: $0 <iterations>"
  exit 1
fi

# For each iteration, run Claude Code with the following prompt.
# This prompt is basic, we'll expand it later.
for ((i=1; i<=$1; i++)); do
  result=$(opencode --model openai/gpt-5.3-codex run \
"@PRD.md @issues.md @progress-3.txt \
1. Decide which task to work on next from issues.md. \
This should be the one YOU decide has the highest priority, \
- not necessarily the first in the list. \
2. Check any feedback loops, such as types and tests. \
3. Append your progress to the progress-3.txt file. \
4. Update status of tasks in issues.md \
5. Make a git commit of that feature. \
ONLY WORK ON A SINGLE TASK / FEATURE. \
If, while implementing the feature, you notice that all work \
is complete in issues.md, output <promise>COMPLETE</promise>. \
")

  echo "$result"

  if [[ "$result" == *"<promise>COMPLETE</promise>"* ]]; then
    echo "PRD complete, exiting."
    exit 0
  fi
done