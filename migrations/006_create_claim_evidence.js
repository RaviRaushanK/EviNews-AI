'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('claim_evidence', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
        comment: 'Unique identifier for the evidence link'
      },
      claim_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'claims', key: 'id' },
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
        comment: 'Foreign key to claims.id'
      },
      article_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'articles', key: 'id' },
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
        comment: 'Foreign key to articles.id'
      },
      evidence_text: {
        type: Sequelize.TEXT,
        allowNull: false,
        comment: 'Supporting text snippet from the article (full text preserved)'
      },
      evidence_hash: {
        type: Sequelize.CHAR(64),
        allowNull: false,
        comment: 'SHA-256 of normalized evidence_text — used for duplicate-safe uniqueness without truncating text'
      },
      evidence_location: {
        type: Sequelize.JSON,
        allowNull: true,
        comment: 'Metadata to locate the snippet'
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

    await queryInterface.addIndex('claim_evidence', ['claim_id'], {
      name: 'idx_claim_evidence_claim_id'
    });
    await queryInterface.addIndex('claim_evidence', ['article_id'], {
      name: 'idx_claim_evidence_article_id'
    });
    await queryInterface.addIndex('claim_evidence', ['claim_id', 'article_id', 'evidence_hash'], {
      name: 'idx_claim_evidence_unique',
      unique: true
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('claim_evidence');
  }
};