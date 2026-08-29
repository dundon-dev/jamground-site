<?php
/**
 * Jamground mu-plugin.
 *
 * Not installed by Composer or a plugin zip: the shell writes this file into the
 * Playground WASM filesystem at wp-content/mu-plugins/jamground.php after boot
 * (see entry.mjs). The blueprint carries no content.
 *
 * The allowlist below is a content-quality and round-trip mechanism, never a security
 * control — Playground cannot enforce authorization, so least privilege is
 * enforced entirely at the GitHub layer.
 *
 * Five hooks, in this order:
 *   0. init                      — register the jamground_author post type
 *   1. allowed_block_types_all   — the inserter allowlist, per post type
 *   2. register_block_type_args  — strips supports before registration
 *   3. enqueue_block_assets      — shared block stylesheet
 *   4. admin_init                — suppress the welcome guide
 *
 * No jamground/* block is registered here: this release ships none, so the allowlist below
 * is core blocks only.
 */

// 0. The author post type.
//
// Pages and posts already have somewhere to live in wp-admin, because WordPress ships those
// types itself. An author has nowhere at all, and until it does the editor's own claim — that
// what is in wp-admin is what the site serves — is false for one of the three kinds of thing
// the site serves.
//
//   public       => false   an author has no WordPress front end. The site renders its own
//                           author pages from the content repository; a WordPress permalink
//                           for one would be a second, wrong address for the same person.
//   show_ui      => true    which is what puts it in the admin menu, and is the whole point.
//                           `show_in_menu` follows `show_ui` by default, so it gets its own
//                           top-level entry rather than hiding under another type's.
//   show_in_rest => true    the block editor and the modern admin data layer both read the
//                           REST index; a type absent from it is invisible to them.
//   supports     => title   THE TITLE AND NOTHING ELSE. An author is not a document: the
//                           contract's `Author` has no `blocks` field, so there is no body to
//                           edit and nowhere to keep one. Declaring only `title` is what makes
//                           WordPress offer a headline and an address and no canvas at all,
//                           rather than offering a canvas whose contents could never be saved.
//                           `name`, `role` and `bio` are carried through the save untouched
//                           and are not edited here yet.
//
// Registered on `init`, so it exists before anything inserts a row: entry.mjs writes this file
// into the WASM filesystem BEFORE it imports, and import.mjs's PHP begins with
// `require wp-load.php`, which loads mu-plugins and fires `init` before `wp_insert_post` runs.
add_action('init', function () {
    register_post_type('jamground_author', [
        'labels' => [
            'name'               => 'Authors',
            'singular_name'      => 'Author',
            'menu_name'          => 'Authors',
            'add_new_item'       => 'Add New Author',
            'edit_item'          => 'Edit Author',
            'new_item'           => 'New Author',
            'view_item'          => 'View Author',
            'search_items'       => 'Search Authors',
            'not_found'          => 'No authors found',
            'not_found_in_trash' => 'No authors found in Trash',
            'all_items'          => 'All Authors',
        ],
        'public'       => false,
        'show_ui'      => true,
        'show_in_rest' => true,
        'supports'     => ['title'],
        'menu_icon'    => 'dashicons-admin-users',
        'has_archive'  => false,
        'rewrite'      => false,
    ]);
});

// 1. The inserter allowlist, PER POST TYPE. core/list-item is required for core/list to
// function and is never itself an inserter entry, so its absence from the inserter is not
// asserted.
//
// An author has no blocks — not "no blocks yet", but none by construction, because `Author`
// has no `blocks` field for one to be written into. Offering an inserter full of blocks that
// cannot be saved would be an invitation to lose work, so the honest allowlist for that type
// is the empty one. Every other type keeps the nine core blocks.
//
// The signature is `10, 2` rather than `10, 0` so the filter receives the block editor's
// context and can answer differently per type. `$context->post` is null in the contexts that
// have no post at all (the site and widget editors), which is why it is checked before use.
add_filter('allowed_block_types_all', function ($allowed_block_types, $block_editor_context) {
    if (isset($block_editor_context->post) && $block_editor_context->post->post_type === 'jamground_author') {
        return [];
    }
    return [
        'core/paragraph',
        'core/heading',
        'core/list',
        'core/list-item',
        'core/image',
        'core/quote',
        'core/code',
        'core/table',
        'core/separator',
    ];
}, 10, 2);

// 2. Strip supports the contract cannot express, before registration — so the controls
// never appear, rather than appearing and being refused at save time.
add_filter('register_block_type_args', function ($args) {
    $args['supports'] = array_merge($args['supports'] ?? [], [
        'color' => false,
        'typography' => false,
        'spacing' => false,
        'border' => false,
        'shadow' => false,
        'className' => false,
        'customClassName' => false,
        'anchor' => false,
        'align' => false,
        'dimensions' => false,
        'position' => false,
        'layout' => false,
        'filter' => false,
    ]);
    return $args;
}, 10, 1);

// 3. The shared block stylesheet. Registered
// with a false source and enqueued on enqueue_block_assets so it loads inside the editor
// canvas as well as the front end preview; a custom property is set so a test can observe
// that this hook actually ran.
add_action('init', function () {
    wp_register_style('jamground-blocks', false);
    wp_add_inline_style('jamground-blocks', 'body{--jp-mu-plugin:present;}');
});
add_action('enqueue_block_assets', function () {
    wp_enqueue_style('jamground-blocks');
});

// 4. Suppress the welcome guide. An editor whose familiarity is the product should not
// be met by WordPress's own onboarding modal.
add_action('admin_init', function () {
    update_user_meta(get_current_user_id(), 'wp_persisted_preferences', [
        'core/edit-post' => ['welcomeGuide' => false],
        'core' => ['welcomeGuide' => false],
    ]);
});
