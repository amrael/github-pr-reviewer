#!/usr/bin/env bash
set -euo pipefail

# PR Review Helper Script
# Usage: review-pr.sh [--prepare|--post|--full] [OPTIONS]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMP_BASE="/tmp/pr-review"

# Default options
ACTION=""
PR_NUMBER=""
REPO=""
REVIEW_TEXT=""
REVIEW_ALL=false
DRY_RUN=false

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging functions
info() { echo -e "${BLUE}ℹ${NC} $*"; }
success() { echo -e "${GREEN}✓${NC} $*"; }
error() { echo -e "${RED}✗${NC} $*" >&2; }
warn() { echo -e "${YELLOW}⚠${NC} $*"; }

# Parse arguments
AUTO_CLEANUP=false
while [[ $# -gt 0 ]]; do
  case $1 in
    --prepare|--post|--cleanup)
      ACTION="$1"
      shift
      ;;
    --pr)
      PR_NUMBER="$2"
      shift 2
      ;;
    --repo)
      REPO="$2"
      shift 2
      ;;
    --review-file)
      REVIEW_TEXT=$(cat "$2")
      shift 2
      ;;
    --auto-cleanup)
      AUTO_CLEANUP=true
      shift
      ;;
    --all)
      REVIEW_ALL=true
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --help)
      cat << EOF
Usage: review-pr.sh ACTION [OPTIONS]

Actions:
  --prepare           Clone PR and return directory path
  --post             Post review to GitHub PR
  --cleanup          Clean up temporary directories

Options:
  --pr NUMBER         PR number
  --repo OWNER/REPO   Repository
  --review-file FILE  File containing review text (for --post)
  --auto-cleanup     Auto-delete clone dir after --post (default: keep)
  --all              Process all assigned PRs
  --dry-run          Preview only

Examples:
  # Prepare PR for review
  review-pr.sh --prepare --pr 1719 --repo srush-inc/anvil-srushboard

  # Post review with auto-cleanup
  review-pr.sh --post --pr 1719 --repo srush-inc/anvil-srushboard --review-file review.txt --auto-cleanup

  # Cleanup all
  review-pr.sh --cleanup
EOF
      exit 0
      ;;
    *)
      error "Unknown option: $1"
      exit 1
      ;;
  esac
done

# Cleanup function
cleanup_all() {
  if [[ -d "$TEMP_BASE" ]]; then
    info "Cleaning up $TEMP_BASE"
    rm -rf "$TEMP_BASE"
    success "Cleanup complete"
  else
    info "Nothing to clean up"
  fi
}

# Detect PRs assigned to current user
detect_prs() {
  info "Searching for PRs where you're requested as reviewer..." >&2
  local result
  result=$(gh search prs --review-requested=@me --state=open --json number,title,repository,url --limit 10 2>&1)
  
  # Check if result is valid JSON
  if ! echo "$result" | jq empty 2>/dev/null; then
    error "Failed to fetch PRs: $result" >&2
    return 1
  fi
  
  echo "$result"
}

# Get PR details
get_pr_details() {
  local repo="$1"
  local pr="$2"
  gh pr view "$pr" --repo "$repo" --json number,title,headRefName,baseRefName,url
}

# Clone and checkout PR (--prepare)
prepare_pr() {
  local repo="$1"
  local pr="$2"
  
  if [[ -z "$repo" ]] || [[ -z "$pr" ]]; then
    error "Both --repo and --pr are required for --prepare"
    exit 1
  fi
  
  local clone_dir="$TEMP_BASE/$(basename "$repo")-pr-$pr"
  
  if [[ -d "$clone_dir" ]]; then
    warn "Directory already exists: $clone_dir"
    echo "$clone_dir"
    return 0
  fi
  
  info "Cloning $repo (PR #$pr)..."
  if [[ "$DRY_RUN" == "true" ]]; then
    warn "DRY RUN - would clone to $clone_dir"
    echo "$clone_dir"
    return 0
  fi
  
  mkdir -p "$TEMP_BASE"
  gh repo clone "$repo" "$clone_dir" -- --filter=blob:none

  cd "$clone_dir"

  # Get PR branch name
  local branch
  branch=$(gh pr view "$pr" --json headRefName --jq '.headRefName')

  info "Checking out PR branch: $branch"
  git fetch origin "$branch"
  git checkout -b review-branch FETCH_HEAD

  # Ensure merge-base with master is available
  git fetch origin master
  if ! git merge-base origin/master HEAD >/dev/null 2>&1; then
    warn "merge-base not found, fetching full history"
    git fetch --unshallow origin
  fi
  
  success "PR #$pr ready at: $clone_dir"
  echo "$clone_dir"
}

# Post review to GitHub (--post)
post_review() {
  local repo="$1"
  local pr="$2"
  local review_text="$3"
  
  if [[ -z "$repo" ]] || [[ -z "$pr" ]]; then
    error "Both --repo and --pr are required for --post"
    exit 1
  fi
  
  if [[ -z "$review_text" ]]; then
    error "--review-file is required for --post"
    exit 1
  fi
  
  info "Posting review to PR #$pr in $repo..."
  
  if [[ "$DRY_RUN" == "true" ]]; then
    warn "DRY RUN - would post review:"
    echo "$review_text" | head -20
    return 0
  fi
  
  # Wrap in collapsible details tag
  local comment
  comment=$(cat <<EOF
<details>
<summary>🤖 Claude Code Review</summary>

$review_text

---
*Reviewed by Claude Code CLI*
</details>
EOF
)
  
  # Post comment
  local comment_url
  comment_url=$(gh pr comment "$pr" --repo "$repo" --body "$comment")
  
  success "Review posted: $comment_url"
  
  # Auto cleanup if requested
  if [[ "$AUTO_CLEANUP" == "true" ]]; then
    local clone_dir="$TEMP_BASE/$(basename "$repo")-pr-$pr"
    if [[ -d "$clone_dir" ]]; then
      info "Auto-cleaning up $clone_dir"
      rm -rf "$clone_dir"
      success "Cleanup complete"
    fi
  fi
}

# Main execution
main() {
  case "$ACTION" in
    --prepare)
      prepare_pr "$REPO" "$PR_NUMBER"
      ;;
    --post)
      post_review "$REPO" "$PR_NUMBER" "$REVIEW_TEXT"
      ;;
    --cleanup)
      cleanup_all
      ;;
    *)
      # No action specified - show assigned PRs
      if ! prs_json=$(detect_prs); then
        error "Failed to detect PRs"
        exit 1
      fi
      
      pr_count=$(echo "$prs_json" | jq '. | length')
      
      if [[ "$pr_count" -eq 0 ]]; then
        info "No PRs assigned to you"
        exit 0
      fi
      
      success "Found $pr_count PR(s) assigned to you:"
      echo "$prs_json" | jq -r '.[] | "  • #\(.number) - \(.title) (\(.repository.nameWithOwner))"'
      echo ""
      info "Use --prepare to clone a PR for review"
      ;;
  esac
}

main
