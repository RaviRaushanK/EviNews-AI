'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('articles', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
        comment: 'Unique identifier for the article'
      },
      source_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'sources', key: 'id' },
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
        comment: 'Foreign key to sources.id'
      },
      title: {
        type: Sequelize.TEXT,
        allowNull: false,
        comment: 'Article headline'
      },
      description: {
        type: Sequelize.TEXT,
        allowNull: true,
        comment: 'Short summary or lead paragraph'
      },
      content: {
        type: Sequelize.TEXT('long'),
        allowNull: true,
        comment: 'Full article body (nullable)'
      },
      url: {
        type: Sequelize.TEXT,
        allowNull: false,
        comment: 'Canonical URL of the article (full text preserved; uniqueness enforced through url_hash)'
      },
      url_hash: {
        type: Sequelize.CHAR(64),
        allowNull: false,
        unique: true,
        comment: 'SHA-256 of normalized URL used for MySQL-safe duplicate protection'
      },
      author: {
        type: Sequelize.STRING(255),
        allowNull: true,
        comment: 'Author name(s)'
      },
      published_at: {
        type: Sequelize.DATE,
        allowNull: true,
        comment: 'When the article was originally published'
      },
      fetched_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW,
        comment: 'When the article was fetched by our system'
      },
      image_url: {
        type: Sequelize.STRING(1024),
        allowNull: true,
        comment: 'URL to a representative image'
      },
      content_hash: {
        type: Sequelize.STRING(64),
        allowNull: false,
        unique: true,
        comment: 'SHA-256 hash of normalized article content'
      },
      processing_status: {
        type: Sequelize.ENUM(
          'collected',
          'cleaned',
          'embedded',
          'clustered',
          'claims_extracted',
          'processed',
          'failed'
        ),
        allowNull: false,
        defaultValue: 'collected',
        comment: 'Current stage of the processing pipeline'
      },
      processing_error: {
        type: Sequelize.TEXT,
        allowNull: true,
        comment: 'Error message if processing failed'
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW
      }
    });

    await queryInterface.addIndex('articles', ['url_hash'], {
      name: 'idx_articles_url_hash',
      unique: true
    });
    await queryInterface.addIndex('articles', ['source_id'], {
      name: 'idx_articles_source_id'
    });
    await queryInterface.addIndex('articles', ['published_at'], {
      name: 'idx_articles_published_at'
    });
    await queryInterface.addIndex('articles', ['processing_status'], {
      name: 'idx_articles_processing_status'
    });
    await queryInterface.addIndex('articles', ['fetched_at'], {
      name: 'idx_articles_fetched_at'
    });
    await queryInterface.addIndex('articles', ['source_id', 'published_at'], {
      name: 'idx_articles_source_published',
      desc: ['published_at']
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('articles');
  }
};